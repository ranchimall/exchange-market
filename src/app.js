'use strict';
const express = require('express');
//const cookieParser = require("cookie-parser");
//const sessions = require('express-session');
const Request = require('./request');

const {
    PERIOD_INTERVAL
} = require("./_constants")["app"];

module.exports = function App(secret, DB) {

    if (!(this instanceof App))
        return new App(secret, DB);

    var server = null;
    const app = express();
    //session middleware
    /*app.use(sessions({
        secret: secret,
        saveUninitialized: true,
        resave: false,
        name: "session"
    }));*/
    // parsing the incoming data
    app.use(express.json());
    app.use(express.urlencoded({
        extended: true
    }));
    //serving public file
    app.use(express.static(PUBLIC_DIR));
    // cookie parser middleware
    //app.use(cookieParser());

    /* Decentralising - Users will load from user-end files and request via APIs only
    //Initital page loading
    app.get('/', (req, res) => res.sendFile('home.html', {
        root: PUBLIC_DIR
    }));
    */

    app.use(function(req, res, next) {
        res.setHeader('Access-Control-Allow-Origin', "*");
        // Request methods you wish to allow
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        // Request headers you wish to allow
        res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
        // Pass to next layer of middleware
        next();
    })

    //get code for login
    app.get('/get-login-code', Request.getLoginCode);

    //login request
    app.post('/login', Request.Login);

    //logout request
    app.post('/logout', Request.Logout);

    //place sell or buy order
    app.post('/buy', Request.PlaceBuyOrder);
    app.post('/sell', Request.PlaceSellOrder);

    //cancel sell or buy order
    app.post('/cancel', Request.CancelOrder);

    //transfer amount to another user
    app.post('/transfer-token', Request.TransferToken);

    //list all orders and trades
    app.get('/list-sellorders', Request.ListSellOrders);
    app.get('/list-buyorders', Request.ListBuyOrders);
    app.get('/list-trades', Request.ListTradeTransactions);
    
    //get rates and tx
    app.get('/get-rates', Request.getRates);
    app.get('/get-transaction', Request.getTransaction);

    //get account details
    app.post('/account', Request.Account);

    //withdraw and deposit request
    app.post('/deposit-flo', Request.DepositFLO);
    app.post('/withdraw-flo', Request.WithdrawFLO);
    app.post('/deposit-token', Request.DepositToken);
    app.post('/withdraw-token', Request.WithdrawToken);

    //Manage user tags (Access to trusted IDs only)
    app.post('/add-tag', Request.addUserTag);
    app.post('/remove-tag', Request.removeUserTag);

    Request.DB = DB;
    Request.secret = secret;

    //Properties
    var periodInstance = null;
    let self = this;

    //return server, express-app
    Object.defineProperty(self, "server", {
        get: () => server
    });
    Object.defineProperty(self, "express", {
        get: () => app
    });

    //set trustedID for subAdmin requests
    Object.defineProperty(self, "trustedIDs", {
        set: (ids) => Request.trustedIDs = ids
    });

    Object.defineProperty(self, "assetList", {
        set: (assets) => Request.assetList = assets
    });

    //Start (or) Stop servers
    self.start = (port) => new Promise(resolve => {
        server = app.listen(port, () => {
            resolve(`Server Running at port ${port}`);
        });
    });
    self.stop = () => new Promise(resolve => {
        server.close(() => {
            server = null;
            resolve('Server stopped');
        });
    });

    //(Node is not master) Pause serving the clients
    self.pause = () => {
        Request.pause();
        if (periodInstance !== null) {
            clearInterval(periodInstance);
            periodInstance = null;
        }
    }

    //(Node is master) Resume serving the clients
    self.resume = () => {
        Request.resume();
        Request.periodicProcess();
        if (periodInstance === null)
            periodInstance = setInterval(Request.periodicProcess, PERIOD_INTERVAL);
    }

    Object.defineProperty(self, "periodInstance", {
        get: () => periodInstance
    });
}