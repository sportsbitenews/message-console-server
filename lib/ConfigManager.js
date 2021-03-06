var Sequelize = require('sequelize')
, MMXManager = require('../lib/MMXManager')
, fs = require('fs')
, mysql = require('mysql')
, _ = require('underscore')
, redis = require('redis');

var configPath = './lib/config/config.json';
var autologinConfigPath = './lib/config/auth.json';
var mmxStartupPropertiesPath = './startup.properties';
var REDIS_ID = 'messaging-config';

var ConfigManager = function(){
    this.configs = this.retrieveLocal();
    this.cachedTime = 0;
    return this;
};

ConfigManager.prototype.init = function(cb){
    var me = this;
    if(!me.configs.App.configured){
        return cb();
    }else if(me.configs.Redis.enabled){
        connectRedis(me.configs.Redis, function(e, client){
            if(e) return cb(e);
            me.redis = client;
            if(!me.configs.Redis.storeConfig){
                return me.initComplete(cb);
            }
            me.setConfigsIfNotExist(function(e){
                if(e) return cb(e);
                me.storeLocal(function(e){
                    if(e) return cb(e);
                    me.cachedTime = Date.now();
                    me.initComplete(cb);
                });
            });
        });
    }else{
        me.initComplete(cb);
    }
};

ConfigManager.prototype.initComplete = function(cb){
    this.setMessaging(ENV_CONFIG.MMX, function(e){
        if(e) winston.error('MMXManager: unable to connect to messaging server: ', e);
        cb();
    });
};

ConfigManager.prototype.get = function(feature, cb, useCache){
    var me = this;
    if(me.redis && me.configs.Redis.storeConfig && (!useCache || (!me.configs.Redis.cacheTimeout || me.configs.Redis.cacheTimeout === 0) || ((Date.now() - me.cachedTime)) > ((me.configs.Redis.cacheTimeout || 60) * 1000))){
        me.redis.get(REDIS_ID, function(e, res){
            if(e){
                winston.error('Config: error retrieving config from Redis, falling back to retrieval from memory. error message: ', e);
                return cb(null, feature ? me.configs[feature] : me.configs);
            }
            winston.verbose('Config: retrieved config feature "'+(feature || 'all')+'" from Redis.');
            var configs = JSON.parse(res);
            delete configs.App;
            me.configs = _.extend(me.configs, configs);
            me.storeLocal(function(e){
                if(e) return cb(e);
                me.cachedTime = Date.now();
                cb(null, feature ? me.configs[feature] : me.configs);
            });
        });
    }else{
        cb(null, feature ? me.configs[feature] : me.configs);
    }
};

ConfigManager.prototype.retrieveLocal = function(){
    var obj;
    try{
        obj = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        winston.info('Config: loaded configuration from file: '+configPath);
    }catch(e){
        winston.error('Config: error loading configuration from file '+configPath+': ', e);
        throw(e);
    }
    return obj;
};

ConfigManager.prototype.set = function(feature, obj, cb){
    var me = this, errors = [], key;
    if(!me.configs[feature]){
        winston.error('Config: feature not found: '+feature);
        return cb('invalid-feature');
    }
    for(key in obj){
        if(typeof me.configs[feature][key] !== 'undefined'){
            if(typeof me.configs[feature][key] !== typeof obj[key] && me.configs[feature][key] !== null && obj[key] !== null){
                errors.push(key);
            }
        }
    }
    if(errors.length){
        winston.error('Config: error setting configuration: invalid data types - ', errors);
        return cb(errors);
    }
    for(key in obj){
        if(typeof me.configs[feature][key] !== 'undefined'){
            me.configs[feature][key] = obj[key];
        }
    }
    me.storeLocal(function(e){
        if(e) return cb(e);
        if(me.redis) return me.redis.set(REDIS_ID, JSON.stringify(me.configs), cb);
        cb();
    });
};

ConfigManager.prototype.storeLocal = function(cb){
    var me = this;
    fs.writeFile(configPath, JSON.stringify(this.configs, undefined, 4), function(e){
        if(e){
            winston.error('Config: error saving configuration: ', e);
            return cb('save-error');
        }
        ENV_CONFIG = me.configs;
        cb();
    });
};

/* WIZARD */

ConfigManager.prototype.setDB = function(obj, cb){
    var me = this;
    if(!obj.dbName || !obj.username || !obj.host || !obj.port){
        winston.error('ORM: unable to connect to database: missing required fields');
        return cb('connect-error');
    }
    obj.password = obj.password || null;
    if(obj.createDatabase){
        createOrUseDB(obj, function(e){
            if(e) return cb(e);
            me.initSequelize(obj, cb);
        });
    }else{
        testDB(obj, function(e){
            if(e) return cb(e);
            me.initSequelize(obj, cb);
        });
    }
};

function testDB(obj, cb){
    var connection =  mysql.createConnection({
        host     : obj.host,
        port     : obj.port,
        user     : obj.username,
        password : obj.password
    });
    connection.query('USE '+obj.dbName+';', function(e){
        if(e){
            winston.error('ORM: unable to connect to database: ', e);
            return cb(e.code);
        }
        winston.info('ORM: successfully connected to database "'+obj.dbName+'".');
        return cb('DB_ALREADY_EXISTS');
    });
}

function createOrUseDB(obj, cb){
    var connection =  mysql.createConnection({
        host     : obj.host,
        port     : obj.port,
        user     : obj.username,
        password : obj.password
    });
    connection.query('CREATE DATABASE IF NOT EXISTS '+obj.dbName+' CHARACTER SET '+ENV_CONFIG.Database.charset+';', function(e){
        if(e) return cb(e.code);
        winston.info('ORM: successfully configured database "'+obj.dbName+'".');
        cb();
    });
}

ConfigManager.prototype.initSequelize = function(obj, cb){
    var me = this;
    var sequelize = new Sequelize(
        obj.dbName,
        obj.username,
        obj.password,
        {
            host    : obj.host,
            port    : obj.port,
            logging : winston.verbose,
            define  : {
                charset : 'utf8'
            }
        }
    );
    sequelize.authenticate().complete(function(e){
        if(e){
            winston.error('ORM: unable to connect to database: ', e);
            return cb('connect-error');
        }
        me.set('Database', obj, function(e){
            if(e) return cb(e);
            require('./orm').connect(sequelize).setup('./lib/models', function(){
                winston.info('Config: successfully configured database.');
                cb();
            });
        });
    });
};

ConfigManager.prototype.setAdmin = function(obj, cb){
    var me = this;
    if(!obj.email || !obj.password){
        winston.error('Config: unable to create admin user: missing required fields');
        return cb('missing-fields');
    }
    obj.activated = true;
    obj.userType = 'admin';
    require('./UserManager').create(_.extend({}, obj), function(e){
        if(e){
            require('./AccountManager').manualLogin(obj.email, obj.password, function(e){
                if(e) return cb(e);
                me.setAdminComplete(obj, cb);
            }, true);
        }else{
            me.set('EmailAlerts', {
                recipient : obj.email
            }, function(e){
                if(e) return cb(e);
                me.setAdminComplete(obj, cb);
            });
        }
    });
};

ConfigManager.prototype.setAdminComplete = function(obj, cb){
    var me = this;
    me.setAuthFile({
        email    : obj.email,
        password : obj.password
    });
    me.set('EmailAlerts', {
        recipient : obj.email
    }, function(e){
        if(e) return cb(e);
        winston.info('Config: successfully created an admin user.');
        cb();
    });
}

ConfigManager.prototype.bootstrapMessaging = function(obj, cb){
    var me = this;
    if(!obj.host || !obj.user || !obj.password || typeof obj.shareDB === 'undefined'){
        winston.error('Config: unable to connect to messaging server: missing required fields');
        return cb('missing-fields');
    }
    if(obj.skipProvisioning){
        me.bootstrapMessagingComplete(obj, true, cb);
    }else{
        var mmxMySQLSettings = !obj.shareDB ? {
            host     : obj['mysqlHost'],
            port     : obj['mysqlPort'],
            dbName   : obj['mysqlDb'],
            username : obj['mysqlUser'],
            password : obj['mysqlPassword']
        } : me.configs.Database;
        MMXManager.provisionServer(obj, {
            'dbHost'                       : mmxMySQLSettings.host,
            'dbPort'                       : mmxMySQLSettings.port,
            'dbName'                       : mmxMySQLSettings.dbName,
            'dbUser'                       : mmxMySQLSettings.username,
            'dbPassword'                   : mmxMySQLSettings.password,
            'mmx.auth.integration.enabled' : me.configs.MMX.mmxAuthIntegrationEnabled,
            'mmx.auth.endpoint.url'        : me.configs.MMX.mmxAuthEndpointUrl,
            'xmppDomain'                   : 'mmx'
        }, function(e, data, code){
            if(code == 201){
                winston.info('Config: bootstrapped messaging server at "'+obj.host+'".');
                me.bootstrapMessagingComplete(obj, false, cb);
            }else if(code == 200){
                me.bootstrapMessagingComplete(obj, true, cb);
            }else if(code == 404){
                return cb('not-found');
            }else if(code == 401 || code == 403){
                return cb('auth-failure');
            }else if(code == 500 || code == 400){
                return cb('install-error');
            }else{
                return cb(code+'-'+e+'-'+data);
            }
        });
    }
};

ConfigManager.prototype.bootstrapMessagingComplete = function(obj, existing, cb){
    var me = this;
    MMXManager.getServerStatus(obj, function(e, status, statusCode){
        if(statusCode == 401 || statusCode == 403) return cb('auth-failure');
        if(statusCode != 200 || !status || status.setupComplete === false) return cb('provision-failure');
        me.set('MMX', {
            host       : obj.host,
            publicPort : parseInt(status.mmxPublicPort),
            adminPort  : parseInt(status.mmxAdminPort)
        }, function(e){
            if(e) return cb(e);
            me.set('Geologging', {
                host : obj.host
            }, function(e){
                if(e) return cb(e);
                winston.info('Config: set up connectivity configuration for messaging server at "'+obj.host+'".');
                if(existing) return cb();
                cb();
            });
        });
    }, {
        port : me.configs.MMX.webPort
    });
};

ConfigManager.prototype.setMessaging = function(obj, cb){
    var me = this;
    var cfg = me.configs.MMX;
    var connect = {
        host     : obj.host || cfg.host,
        webPort  : obj.webPort || cfg.webPort,
        user     : obj.user,
        password : obj.password,
        ssl      : obj.ssl || cfg.ssl
    };
    MMXManager.getServerStatus(connect, function(e, status, code){
        if(code == 401 || code == 403) return cb('auth-failure');
        if(code != 200) return cb(e);
        if(!status || status.setupComplete === false) return cb('not-provisioned');
        connect.adminPort = parseInt(status.mmxAdminPort || 6060);
        connect.publicPort = parseInt(status.mmxPublicPort || 5220);
        MMXManager.getConfigs('', function(e, configs, code2){
            if(e && (code2 == 401 || code2 == 403)) return cb('auth-failure');
            if(e) return cb(e);
            me.set('MMX', connect, function(e){
                if(e) return cb(e);
                winston.info('Config: successfully configured messaging server connectivity to "'+connect.host+':'+connect.webPort+'".');
                cb();
            });
        }, connect);
    }, {
        port : connect.webPort
    });
};

ConfigManager.prototype.setRedis = function(obj, cb){
    var me = this;
    if(obj.enabled && (!obj.host || !obj.port)){
        winston.error('Config: unable to connect to Redis database: missing required fields');
        return cb('missing-fields');
    }
    if(obj.enabled){
        connectRedis(obj, function(e, client){
            if(e){
                winston.error('Config: unable to connect to Redis database: ', e);
                return cb('connect-error');
            }
            me.redis = client;
            winston.info('Config: successfully connected to Redis database.');
            if(!obj.storeConfig){
                return me.setRedisComplete(obj, cb);
            }
            me.setConfigsIfNotExist(function(e){
                if(e) return cb(e);
                me.setRedisComplete(obj, cb);
            });
        });
    }else{
        delete me.redis;
        me.setRedisComplete(obj, cb);
    }
};


ConfigManager.prototype.setRedisComplete = function(obj, cb){
    var me = this;
    me.set('Redis', obj, function(e){
        if(e){
            winston.error('Config: unable to store Redis config: ', e);
            return cb('connect-error');
        }
        winston.info('Config: successfully configured Redis.');
        cb();
    });
};

ConfigManager.prototype.setConfigsIfNotExist = function(cb, redisObj){
    var me = this;
    me.redis.get(REDIS_ID, function(e, res){
        if(e)
            return cb(e);
        if(!res)
            return me.redis.set(REDIS_ID, JSON.stringify(me.configs), cb);
        var configs = JSON.parse(res);
        delete configs.App;
        me.configs = _.extend(me.configs, configs);
        cb();
    });
};

function connectRedis(obj, cb){
    if(obj.enabled === false) return cb();
    var client = redis.createClient(obj.port, obj.host);
    if(obj.pass) client.auth(obj.pass);
    client.on('error', function(e){
        winston.error('Config: unable to connect to Redis database: connection error');
        cb('connect-error');
    });
    client.on('connect', function(err){
        winston.info('Config: connected to Redis database.');
        cb(null, client);
    });
    client.get('redis-init', function(e, reply){});
}

ConfigManager.prototype.completeInstall = function(cb){
    this.set('App', {
        configured : true
    }, function(e){
        if(e) return cb(e);
        winston.info('Config: successfully completed the installation.');
        cb();
    });
};

var allowedConfigs = ['MMX'];

ConfigManager.prototype.getConfigs = function(cb, allowAll){
    var me = this, cfg = {};
    me.get(null, function(e, configs){
        if(e) return cb(e);
        for(var section in configs){
            cfg[section] = {};
            for(var item in configs[section]){
                if(allowAll || allowedConfigs.indexOf(section) != -1 || !isPrivate(item)) cfg[section][item] = configs[section][item];
            }
        }
        cb(null, cfg);
    }, true);
};

ConfigManager.prototype.getConfig = function(section, cb){
    var me = this, cfg = {};
    if(!me.configs[section]) return cb('invalid-section');
    me.get(section, function(e, feature){
        if(e) return cb(e);
        for(var item in feature){
            if(allowedConfigs.indexOf(section) != -1 || !isPrivate(item)) cfg[item] = feature[item];
        }
        cb(null, cfg);
    }, true);
};

ConfigManager.prototype.retrieveLocalStartupProperties = function(){
    var me = this;
    var props = {}, prop;
    try{
        var data = fs.readFileSync(mmxStartupPropertiesPath, 'utf8');
        data = data.split(/\r?\n/);
        for(var key in data){
            prop = data[key].split('=');
            if(!isNaN(parseFloat(prop[1])) && isFinite(prop[1])){
                prop[1] = parseInt(prop[1]);
            }
            if(prop[1] === 'false') prop[1] = false;
            if(prop[1] === 'true') prop[1] = true;
            props[prop[0]] = prop[1];
        }
        winston.info('Config: startup.properties found at '+mmxStartupPropertiesPath);
        me.configs.App.appUrl = me.configs.App.appUrl.replace(me.configs.App.port, props.consolePort);
        me.configs.App.port = props.consolePort;
        me.configs.MMX.webPort = props.httpPort;
        if(props.mmxAuthIntegrationEnabled === true){
            me.configs.MMX.mmxAuthIntegrationEnabled = props.mmxAuthIntegrationEnabled;
            me.configs.MMX.mmxAuthEndpointUrl = props.mmxAuthEndpointUrl;
        }
        me.storeLocal(function(e){
            if(me.redis){
                return me.redis.set(REDIS_ID, JSON.stringify(me.configs), function(){});
            }
        });
    }catch(e){
        winston.verbose('Config: startup.properties not found at '+mmxStartupPropertiesPath);
    }
};

ConfigManager.prototype.setLocalStartupProperties = function(cb){
    var me = this;
    fs.stat(mmxStartupPropertiesPath, function(e){
        if(e && e.code === "ENOENT") return cb();
        fs.writeFile(mmxStartupPropertiesPath, 'consolePort='+me.configs.App.port+'\r\nhttpPort='+me.configs.MMX.webPort, function(e){
            if(e) return cb();
            cb();
        });
    });
};

ConfigManager.prototype.getAutoLoginConfig = function(cb){
    fs.readFile(autologinConfigPath, {encoding : 'utf-8'}, function(e, data){
        if(e) return cb(e);
        winston.silly('Config: loaded auth file: '+autologinConfigPath);
        try{
            var obj = JSON.parse(data);
            fs.unlink(autologinConfigPath, function(e){
                if(e) return cb();
                winston.silly('Config: deleted auth file: '+autologinConfigPath);
                cb(null, obj);
            });
        }catch(e){
            return cb('invalid-format');
        }
    });
};

ConfigManager.prototype.setAuthFile = function(auth){
    fs.writeFile(autologinConfigPath, JSON.stringify(auth, undefined, 4));
};

ConfigManager.prototype.setConfig = function(section, configs, cb){
    var me = this;
    if(!me.configs[section] && section != 'MessagingSettings') return cb('invalid-section');
    if(section == 'Database') return me.setDB(configs, cb);
    if(section == 'MMX') return me.setMessaging(configs, cb);
    if(section == 'MessagingSettings')
        return MMXManager.setConfigs({
            configs : configs
        }, function(e){
            if(e) return cb(e);
            winston.info('Config: successfully configured messaging server properties.');
            cb();
        });
    if(section == 'Redis') return me.setRedis(configs, cb);
    if(section == 'Geologging') return require('../lib/Geologger').setConfig(configs, cb);
    if(section == 'FileLog') return require('../lib/LogManager').setFileLogHandler(false, configs, function(e){
            if(e) return cb(e);
            me.set('FileLog', configs, function(e){
                if(e) return cb(e);
                winston.info('Config: successfully configured section "'+section+'" of config.');
                cb();
            });
        });
    me.set(section, configs, function(e){
        if(e) return cb(e);
        if(['EmailAlerts', 'DatabaseLog', 'ConsoleLog'].indexOf(section) != -1)
            require('../lib/LogManager').setHandler(section);
        winston.info('Config: successfully configured section "'+section+'" of config.');
        if(section == 'App'){
            return me.setLocalStartupProperties(cb);
        }else{
            cb();
        }
    });
};

ConfigManager.prototype.define = function(){
    fs = arguments[0] || require('fs');
    mysql = arguments[1] || require('mysql');
    redis = arguments[2] || require('redis');
    Sequelize = arguments[3] || require('sequelize');
    MMXManager = arguments[4] || require('../lib/MMXManager');
};

function isPrivate(key){
    return key.toLowerCase().indexOf('pass') !== -1 || key.toLowerCase().indexOf('sessionsecret') !== -1;
}

module.exports = new ConfigManager();
module.exports.autologinConfigPath = autologinConfigPath;