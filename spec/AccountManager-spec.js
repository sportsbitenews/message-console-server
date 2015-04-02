var AccountManager = require("../lib/AccountManager")
 , Helper = require('./Helper')
 , orm = require('../lib/orm')
, magnetId = require('node-uuid');

jasmine.getEnv().defaultTimeoutInterval = 30000;

describe('AccountManager', function(){

    var id = magnetId.v1(), id2 = magnetId.v1(), id3 = magnetId.v1();
    var password = '$2a$10$.zrAuu55WS8ntazOHo6KKuY0xDkarNOmxLoGRPGrc3hl1iNprp7si'; // 'admin'
    var user1 = {
        magnetId  : id,
        firstName : 'user',
        lastName  : 'one',
        email     : id+'@magnet.com',
        userType  : 'developer',
        activated : true,
        password  : password
    };
    var user2 = {
        magnetId  : id2,
        firstName : 'user',
        lastName  : 'two',
        email     : id2+'@magnet.com',
        userType  : 'developer',
        activated : false,
        password  : password
    };
    var user3 = {
        magnetId  : id3,
        firstName : 'user',
        lastName  : 'three',
        email     : id3+'@magnet.com',
        userType  : 'developer',
        activated : true,
        password  : password
    };

    it('should set up test users', function(done){
        orm.setup('./lib/models', function(){
            orm.model('User').create(user1).then(function(res1){
                expect(res1.lastName).toEqual(user1.lastName);
                orm.model('User').create(user2).then(function(res2){
                    expect(res2.lastName).toEqual(user2.lastName);
                    orm.model('User').create(user3).then(function(res3){
                        expect(res3.lastName).toEqual(user3.lastName);
                        done();
                    }).catch(function(e){
                        expect(e).toEqual('failed-test');
                        done();
                    });
                }).catch(function(e){
                    expect(e).toEqual('failed-test');
                    done();
                });
            }).catch(function(e){
                expect(e).toEqual('failed-test');
                done();
            });
        });
    });

    describe('login', function(){

        describe('should fail', function(){

            it("if input is invalid", function(done) {
                AccountManager.manualLogin(3233, 'test', function(e, user){
                    expect(e).toEqual('invalid-login');
                    done();
                });
            });

            it("if the email didn't exist", function(done) {
                AccountManager.manualLogin('non-exist@magnet.com', 'test', function(e, user){
                    expect(e).toEqual('invalid-login');
                    done();
                });
            });

            it("if the user is not approved", function(done) {
                AccountManager.manualLogin(user2.email, 'admin', function(e, u){
                    expect(e).toEqual('account-locked');
                    done();
                });
            });

            it("if the password didn't match", function(done) {
                AccountManager.manualLogin(user3, 'invalid-pass', function(e, u){
                    expect(e).toEqual('invalid-login');
                    done();
                });
            });

        });

        describe('should succeed', function(){

            it("if the credentials are valid", function(done) {
                AccountManager.manualLogin(user1.email, 'admin', function(e, user){
                    expect(e).toBeNull();
                    expect(user.email).toEqual(user1.email);
                    done();
                });
            });

        });

    });

});


