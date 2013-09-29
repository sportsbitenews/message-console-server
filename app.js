/* Module dependencies */

var express = require('express')
, http = require('http')
, app = express()
, engine = require('ejs-locals')
, server = http.createServer(app)
, connect = require('express/node_modules/connect')
, fs = require('fs');

require('./lib/orm').setup('./lib/models', true, 'developercenter', 'root');

// TODO: Take out before hitting production
// Authentication module.
var auth = require('http-auth');
var basic = auth.basic({
    realm: "Authenticated Area.",
    file: "./data/users.htpasswd" // manager1@magnetapi.com/test
});

var secret = 'ThisSecretShouldBeChanged';
var cookieParser = express.cookieParser(secret);
var sessionStore = new connect.middleware.session.MemoryStore();

app.on('uncaughtException', function(error){
    console.error('Uncaught Error: ');
    console.error(error.stack);
});

// Configuration

// use ejs-locals for all ejs templates:
app.engine('ejs', engine);

app.configure(function(){

    app.set('port', 3000);

    app.set('views', __dirname + '/views');

    app.locals({
        _layoutFile : '/layouts/site'
    });

    app.locals.open = '{{';
    app.locals.close = '}}';

    //app.set('template_engine', 'ejs');
    app.set('view engine', 'ejs');

    app.use(express.bodyParser());

    app.use(cookieParser);
    app.use(express.session({
        store  : sessionStore,
        secret : secret // secure session
    }));

    app.use(express.methodOverride());

    // prioritize router before public directory
    app.use(express.static(__dirname + '/public'));
});

app.configure('development', function(){
    app.use(express.errorHandler({
        dumpExceptions : true,
        showStack      : true
    }));
});

app.configure('production', function(){
    app.use(express.errorHandler());
    // TODO: Take out before hitting production
    app.use(auth.connect(basic));
});

// Global variables

GLOBAL.app = app;
GLOBAL.http = http;
GLOBAL.fs = fs;
GLOBAL.tmplVars = {
    resourceUrl : 'localhost:3000/resources'
};

// Routes

require('./routes')(app);

// Listener

server.listen(app.get('port'), function(){
    console.info("Express: server listening on port %d in %s mode", app.get('port'), app.settings.env);
});