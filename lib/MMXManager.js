var http = require('follow-redirects').http
, https = require('follow-redirects').https
, ejs = require('ejs')
, fs = require('fs')
, magnetId = require('node-uuid');

var MMXManager = function(){};

MMXManager.prototype.request = function(path, method, data, cb, params){
    params = params || {};
    var type = params.contentType ? params.contentType : 'application/x-www-form-urlencoded';
    var reqBody = parseBody(type, data);
    var protocol = ENV_CONFIG.MMX.ssl === true ? https : http;
    var queryPath = path+((method === 'GET' || params.queryOnly) ? '?'+reqBody : '');
    queryPath = queryPath == '?' ? '' : queryPath;
    winston.verbose({
        host    : ENV_CONFIG.MMX.host,
        port    : ENV_CONFIG.MMX.port || (ENV_CONFIG.MMX.ssl === true ? 443 : 80),
        path    : queryPath,
        method  : method || 'GET',
        rejectUnauthorized : false,
        requestCert        : false,
        headers : {
            'Content-Type'   : type,
            'Content-Length' : reqBody ? reqBody.length : 0,
            'Authorization'  : 'Basic ' + new Buffer(ENV_CONFIG.MMX.user + ':' + ENV_CONFIG.MMX.password).toString('base64')
        }
    });
    var call = protocol.request({
        host    : ENV_CONFIG.MMX.host,
        port    : ENV_CONFIG.MMX.port || (ENV_CONFIG.MMX.ssl === true ? 443 : 80),
        path    : queryPath,
        method  : method || 'GET',
        rejectUnauthorized : false,
        requestCert        : false,
        headers : {
            'Content-Type'   : type,
            'Content-Length' : reqBody ? reqBody.length : 0,
            'Authorization'  : 'Basic ' + new Buffer(ENV_CONFIG.MMX.user + ':' + ENV_CONFIG.MMX.password).toString('base64')
        }
    }, function(res){
        var data = '';
        res.setEncoding('utf8');
        res.on('data', function(chunk){
            data += chunk;
        }).on('end', function(){
            try{
                data = JSON.parse(data);
            }catch(e){}
            if(!isSuccess(res.statusCode)) winston.error('MMXManager: failed to make remote call to '+ENV_CONFIG.MMX.host+' '+path+': code - '+res.statusCode+' response: ', data, ' request: ', reqBody);
            if(typeof cb === typeof Function){
                if(isSuccess(res.statusCode))
                    cb(null, data);
                else
                    cb((typeof data == 'object' && data.message) ? data.message : 'request-failed', data);
            }
        });
    });
    call.on('error', function(e){
        winston.error('MMXManager: failed to make remote call to '+ENV_CONFIG.MMX.host+' '+path+': ',e);
        cb('request-error');
    });
    if(reqBody) call.write(reqBody, 'utf8');
    call.end();
};

// create an mmx app
MMXManager.prototype.createApp = function(userEmail, userMagnetId, body, cb){
    var me = this;
    if(!body) return cb('invalid-body');
    me.request('/plugins/mmxmgmt', 'GET', {
        command    : 'create',
        appName    : body.appName,
        appOwner   : userMagnetId,
        serverUser : userEmail,
        secret     : magnetId.v4()
    }, function(e, data){
        if(e) return cb(e);
        winston.verbose('MMXManager: successfully created mmx app: ' + body.appName+'('+data.appId+')');
        cb(null, filterResponse(data));
    });
};

// get all the mmx apps for the given user
MMXManager.prototype.getApps = function(userMagnetId, cb){
    var me = this;
    me.request('/plugins/mmxmgmt', 'GET', {
        command  : 'read',
        appOwner : userMagnetId
    }, function(e, data){
        if(e) return cb(e);
        data = (data && data.appList) ? data.appList : [];
        for(var i=0;i<data.length;++i){
            data[i] = filterResponse(data[i]);
        }
        cb(null, data);
    });
};

// get statistics for all mmx apps
MMXManager.prototype.getStats = function(userMagnetId, cb){
    var me = this;
    me.request('/plugins/mmxmgmt/rest/v1/stats/ownerId/'+userMagnetId, 'GET', '', function(e, data){
        if(e) return cb(e);
        cb(null, data);
    });
};

// get a single mmx app
MMXManager.prototype.getApp = function(userMagnetId, mmxId, cb){
    var me = this;
    me.request('/plugins/mmxmgmt', 'GET', {
        command  : 'read',
        appId    : mmxId,
        appOwner : userMagnetId
    }, function(e, data){
        if(e) return cb(e);
        cb(null, filterResponse(data));
    });
};

// update an mmx app
MMXManager.prototype.updateApp = function(userMagnetId, isAdmin, mmxId, body, cb){
    var me = this;
    if(!body) return cb('invalid-body');
    var req = {
        command : 'update',
        appId   : mmxId
    };
    if(body.appName) req.appName = body.appName;
    req.googleApiKey = body.googleApiKey || '';
    req.googleProjectId = body.googleProjectId || '';
    req.secret = body.guestUserSecret || '';
    me.request('/plugins/mmxmgmt', 'GET', req, function(e, data){
        if(e) return cb(e);
        winston.verbose('MMXManager: successfully updated mmx app: ' + mmxId);
        cb(null, data);
    });
};

// delete an mmx app
MMXManager.prototype.deleteApp = function(userMagnetId, isAdmin, mmxId, cb){
    var me = this;
    me.request('/plugins/mmxmgmt', 'GET', {
        command  : 'delete',
        appId    : mmxId,
        appOwner : userMagnetId
    }, function(e, data){
        if(e) return cb(e);
        winston.verbose('MMXManager: successfully deleted mmx app: ' + mmxId);
        cb(null, data);
    });
};

// get all the mmx messages for the given app in the context of the current user
MMXManager.prototype.getAppMessages = function(uid, mmxId, query, cb){
    var me = this;
    query.appId = mmxId;
    me.request('/plugins/mmxmgmt/messages', 'GET', query, function(e, data){
        if(e) return cb(e);
        cb(null, data);
    });
};

// get statistics for the given app
MMXManager.prototype.getAppStats = function(userMagnetId, mmxId, cb){
    var me = this;
    me.request('/plugins/mmxmgmt/rest/v1/stats/ownerId/'+userMagnetId+'/app/'+mmxId, 'GET', '', function(e, data){
        if(e) return cb(e);
        cb(null, data);
    });
};

// get all the users for the given app
MMXManager.prototype.getAppEndpoints = function(uid, mmxId, query, cb){
    var me = this;
    query.appId = mmxId;
    me.request('/plugins/mmxmgmt/rest/v1/endpoints/'+mmxId+'/search', 'GET', query, function(e, data){
        if(e) return cb(e);
        cb(null, data);
    });
};

// get all the users for the given app
MMXManager.prototype.getAppUsers = function(uid, mmxId, query, cb){
    var me = this;
    query.appId = mmxId;
    me.request('/plugins/mmxmgmt/users', 'GET', query, function(e, data){
        if(e) return cb(e);
        cb(null, data);
    });
};

// get all the mmx devices for the given user
MMXManager.prototype.getAppUserDevices = function(uid, mmxId, mmxUid, cb){
    var me = this;
    me.request('/plugins/mmxmgmt/devices', 'GET', {
        appId    : mmxId,
        searchby : 'username',
        value    : mmxUid
    }, function(e, data){
        if(e) return cb(e);
        cb(null, data);
    });
};

// get all the push messages for the given device
MMXManager.prototype.getDeviceMessages = function(uid, mmxId, mmxDid, cb){
    var me = this;
//    return cb(null, devices);
    me.request('/plugins/mmxmgmt/pushmessages', 'GET', {
        appId    : mmxId,
        deviceid : mmxDid
    }, function(e, data){
        if(e) return cb(e);
        cb(null, data);
    }, {
        queryOnly : true
    });
};

// send a message to a user or device
MMXManager.prototype.sendMessage = function(uid, mmxId, mmxDeviceId, body, cb){
    var me = this;
    var obj = {
        clientId    : body.userId,
        deviceId    : body.deviceId,
        content     : body.payload,
        contentType : 'text',
        type        : 'chat',
        requestAck  : true
    };
    me.request('/plugins/mmxmgmt/send?appId='+mmxId, 'POST', obj, function(e, data){
        if(e) return cb(e);
        cb(null, 'ok');
    }, {
        contentType : 'application/json'
    });
};

// send a ping to a device
MMXManager.prototype.sendPing = function(uid, mmxId, mmxDeviceId, body, cb){
    var me = this;
    if(!body.deviceId) return cb('invalid-device-id');
    me.request('/plugins/mmxmgmt/push', 'POST', {
        appId    : mmxId,
        deviceid : body.deviceId,
        pingtest : 1
    }, function(e, data){
        if(e) return cb(e);
        cb(null, 'ok');
    }, {
        queryOnly : true
    });
};

// send a notification to a device
MMXManager.prototype.sendNotification = function(uid, mmxId, mmxDeviceId, body, cb){
    var me = this;
    if(!body.deviceId) return cb('invalid-device-id');
    me.request('/plugins/mmxmgmt/push?appId='+mmxId+'&deviceid='+body.deviceId, 'POST', body.payload, function(e, data){
        if(e) return cb(e);
        cb(null, 'ok');
    }, {
        contentType : 'text/plain'
    });
};

// create mmx app topic
MMXManager.prototype.createAppTopic = function(uid, mmxId, body, cb){
    var me = this;
    if(!body) return cb('invalid-body');
    me.request('/plugins/mmxmgmt/topic?appId='+mmxId, 'POST', {
        topicId     : body.name,
        topicName   : body.name,
        description : body.name
    }, function(e, data){
        if(e) return cb(e);
        winston.verbose('MMXManager: successfully created mmx app topic: ' + body.name+'('+data.id+')');
        cb(null, data);
    }, {
        contentType : 'application/json'
    });
};

// get all the mmx app topics
MMXManager.prototype.getAppTopics = function(uid, mmxId, query, cb){
    var me = this;
    me.request('/plugins/mmxmgmt/topic', 'GET', {
        appId   : mmxId,
        command : 'listtopic'
    }, function(e, data){
        if(e) return cb(e);
        cb(null, data);
    });
};

// delete mmx app topic
MMXManager.prototype.deleteAppTopic = function(uid, mmxId, topicId, cb){
    var me = this;
    me.request('/plugins/mmxmgmt/topic?topicid='+encodeURIComponent(topicId), 'DELETE', '', function(e, data){
        if(e) return cb(e);
        winston.verbose('MMXManager: successfully deleted mmx app topic: ' + topicId);
        cb(null, data);
    });
};

// publish message to topic
MMXManager.prototype.publishToTopic = function(uid, mmxId, topicId, body, cb){
    var me = this;
    me.request('/plugins/mmxmgmt/rest/v1/topics/post', 'POST', {
        topicId     : decodeURIComponent(topicId),
        appId       : mmxId,
        content     : body.payload,
        messageType : 'normal',
        contentType : 'text'
    }, function(e, data){
        if(e) return cb(e);
        winston.verbose('MMXManager: successfully published to app topic: ' + topicId);
        cb(null, data);
    }, {
        contentType : 'application/json'
    });
};

// retrieve the app configuration
MMXManager.prototype.getConfigs = function(userMagnetId, cb){
    var me = this;
    me.request('/plugins/mmxmgmt/config', 'GET', '', function(e, data){
        cb(null, data);
    });
};

function filterResponse(data){
    data.gcm = data.gcm || {};
    data.id = data.appId;
    data.magnetId = data.appId;
    return data;
}

function filterUsersResponse(data){
    return {
        id               : data.appId,
        magnetId         : data.appId,
        appName          : data.appName,
        apiKey           : data.apiKey,
        creationDate     : data.creationDate,
        modificationDate : data.modificationDate
    }
}

function isSuccess(code){
    return code >= 200 && code <= 299;
}

function parseBody(type, input){
    var QS = require('querystring');
    switch(type){
        case 'application/x-www-form-urlencoded' : input = QS.stringify(input); break;
        case 'application/json' : input = JSON.stringify(input); break;
    }
    return input;
}

module.exports = new MMXManager();