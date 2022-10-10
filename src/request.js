'use strict';

const market = require("./market");
const conversion = require('./services/conversion');
const blokchain_bonds = require("./services/bonds");

const {
    SIGN_EXPIRE_TIME,
    MAX_SESSION_TIMEOUT
} = require("./_constants")["request"];

const eCode = require('../docs/scripts/floExchangeAPI').errorCode;

var DB, trustedIDs, secret; //container for database

global.INVALID = function (ecode, message) {
    if (!(this instanceof INVALID))
        return new INVALID(ecode, message);
    this.message = message;
    this.ecode = ecode;
}
INVALID.e_code = 400;
INVALID.prototype.toString = function () {
    return "E" + this.ecode + ": " + this.message;
}
INVALID.str = (ecode, message) => INVALID(ecode, message).toString();

global.INTERNAL = function INTERNAL(message) {
    if (!(this instanceof INTERNAL))
        return new INTERNAL(message);
    this.message = message;
}
INTERNAL.e_code = 500;
INTERNAL.prototype.toString = function () {
    return "E" + eCode.INTERNAL_ERROR + ": " + this.message;
}
INTERNAL.str = (ecode, message) => INTERNAL(ecode, message).toString();

const INCORRECT_SERVER_ERROR = INVALID(eCode.INCORRECT_SERVER, "Incorrect server");

var serving;

function validateRequest(request, sign, floID, pubKey) {
    return new Promise((resolve, reject) => {
        if (!serving)
            reject(INCORRECT_SERVER_ERROR);
        else if (!request.timestamp)
            reject(INVALID(eCode.MISSING_PARAMETER, "Timestamp parameter missing"));
        else if (Date.now() - SIGN_EXPIRE_TIME > request.timestamp)
            reject(INVALID(eCode.EXPIRED_SIGNATURE, "Signature Expired"));
        else if (!floCrypto.validateAddr(floID))
            reject(INVALID(eCode.INVALID_FLO_ID, "Invalid floID"));
        else if (typeof request !== "object")
            reject(INVALID(eCode.INVALID_REQUEST_FORMAT, "Request is not an object"));
        else validateRequest.getSignKey(floID, pubKey).then(signKey => {
            let req_str = Object.keys(request).sort().map(r => r + ":" + request[r]).join("|");
            try {
                if (!floCrypto.verifySign(req_str, sign, signKey))
                    reject(INVALID(eCode.INVALID_SIGNATURE, "Invalid request signature"));
                else validateRequest.checkIfSignUsed(sign)
                    .then(result => resolve(req_str))
                    .catch(error => reject(error))
            } catch {
                reject(INVALID(eCode.INVALID_SIGNATURE, "Corrupted sign/key"));
            }
        }).catch(error => reject(error));
    });
}

validateRequest.getSignKey = (floID, pubKey) => new Promise((resolve, reject) => {
    if (!pubKey)
        DB.query("SELECT session_time, proxyKey FROM UserSession WHERE floID=?", [floID]).then(result => {
            if (result.length < 1)
                reject(INVALID(eCode.SESSION_INVALID, "Session not active"));
            else if (result[0].session_time + MAX_SESSION_TIMEOUT < Date.now())
                reject(INVALID(eCode.SESSION_EXPIRED, "Session Expired! Re-login required"));
            else
                resolve(result[0].proxyKey);
        }).catch(error => reject(error));
    else if (floCrypto.getFloID(pubKey) === floID)
        resolve(pubKey);
    else
        reject(INVALID(eCode.INVALID_PUBLIC_KEY, "Invalid pubKey"));
});

validateRequest.checkIfSignUsed = sign => new Promise((resolve, reject) => {
    DB.query("SELECT id FROM RequestLog WHERE sign=?", [sign]).then(result => {
        if (result.length)
            reject(INVALID(eCode.DUPLICATE_SIGNATURE, "Duplicate signature"));
        else
            resolve(true);
    }).catch(error => reject(error))
});

function logRequest(floID, req_str, sign, proxy = false) {
    //console.debug(floID, req_str);
    DB.query("INSERT INTO RequestLog (floID, request, sign, proxy) VALUES (?,?,?, ?)", [floID, req_str, sign, proxy])
        .then(_ => null).catch(error => console.error(error));
}

function processRequest(res, floID, pubKey, sign, rText, validateObj, marketFn) {
    validateRequest(validateObj, sign, floID, pubKey).then(req_str => {
        marketFn().then(result => {
            logRequest(floID, req_str, sign, !pubKey);
            res.send(result);
        }).catch(error => {
            if (error instanceof INVALID)
                res.status(INVALID.e_code).send(error.toString());
            else {
                console.error(error);
                res.status(INTERNAL.e_code).send(INTERNAL.str(rText + " failed! Try again later!"));
            }
        })
    }).catch(error => {
        if (error instanceof INVALID)
            res.status(INVALID.e_code).send(error.toString());
        else {
            console.error(error);
            res.status(INTERNAL.e_code).send(INTERNAL.str("Request processing failed! Try again later!"));
        }
    })
}

/* User Requests */

function Account(req, res) {
    let data = req.body;
    validateRequest({
        type: "get_account",
        timestamp: data.timestamp
    }, data.sign, data.floID, data.pubKey).then(req_str => {
        market.getAccountDetails(data.floID).then(result => {
            result.sinkID = market.chests.pick;
            if (trustedIDs.includes(data.floID))
                result.subAdmin = true;
            res.send(result);
        });
    }).catch(error => {
        if (error instanceof INVALID)
            res.status(INVALID.e_code).send(error.toString());
        else {
            console.error(error);
            res.status(INTERNAL.e_code).send(INTERNAL.str("Request processing failed! Try again later!"));
        }
    });
}

function Login(req, res) {
    let data = req.body;
    if (!data.code || data.hash != Crypto.SHA1(data.code + secret))
        res.status(INVALID.e_code).send(INVALID.str(eCode.INVALID_LOGIN_CODE, "Invalid Code"));
    else if (!data.pubKey)
        res.status(INVALID.e_code).send(INVALID.str(eCode.MISSING_PARAMETER, "Public key missing"));
    else
        processRequest(res, data.floID, data.pubKey, data.sign, "Login", {
            type: "login",
            random: data.code,
            proxyKey: data.proxyKey,
            timestamp: data.timestamp
        }, () => market.login(data.floID, data.proxyKey));
}

function Logout(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Logout", {
        type: "logout",
        timestamp: data.timestamp
    }, () => market.logout(data.floID));
}

function PlaceSellOrder(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Sell order placement", {
        type: "sell_order",
        asset: data.asset,
        quantity: data.quantity,
        min_price: data.min_price,
        timestamp: data.timestamp
    }, () => market.addSellOrder(data.floID, data.asset, data.quantity, data.min_price));
}

function PlaceBuyOrder(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Buy order placement", {
        type: "buy_order",
        asset: data.asset,
        quantity: data.quantity,
        max_price: data.max_price,
        timestamp: data.timestamp
    }, () => market.addBuyOrder(data.floID, data.asset, data.quantity, data.max_price));
}

function CancelOrder(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Order cancellation", {
        type: "cancel_order",
        order: data.orderType,
        id: data.orderID,
        timestamp: data.timestamp
    }, () => market.cancelOrder(data.orderType, data.orderID, data.floID));
}

function TransferToken(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Token Transfer", {
        type: "transfer_token",
        receiver: JSON.stringify(data.receiver),
        token: data.token,
        timestamp: data.timestamp
    }, () => market.transferToken(data.floID, data.receiver, data.token));
}

function DepositFLO(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Deposit FLO", {
        type: "deposit_flo",
        txid: data.txid,
        timestamp: data.timestamp
    }, () => market.depositFLO(data.floID, data.txid));
}

function WithdrawFLO(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Withdraw FLO", {
        type: "withdraw_flo",
        amount: data.amount,
        timestamp: data.timestamp
    }, () => market.withdrawFLO(data.floID, data.amount));
}

function DepositToken(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Deposit Token", {
        type: "deposit_token",
        txid: data.txid,
        timestamp: data.timestamp
    }, () => market.depositToken(data.floID, data.txid));
}

function WithdrawToken(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Withdraw Token", {
        type: "withdraw_token",
        token: data.token,
        amount: data.amount,
        timestamp: data.timestamp
    }, () => market.withdrawToken(data.floID, data.token, data.amount));
}

function GetUserTransacts(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "User Transacts", {
        type: "get_transact",
        timestamp: data.timestamp
    }, () => market.getUserTransacts(data.floID));
}

function AddUserTag(req, res) {
    let data = req.body;
    if (!trustedIDs.includes(data.floID))
        res.status(INVALID.e_code).send(INVALID.str(eCode.ACCESS_DENIED, "Access Denied"));
    else processRequest(res, data.floID, data.pubKey, data.sign, "Add user-tag", {
        type: "add_tag",
        user: data.user,
        tag: data.tag,
        timestamp: data.timestamp
    }, () => market.addTag(data.user, data.tag));
}

function RemoveUserTag(req, res) {
    let data = req.body;
    if (!trustedIDs.includes(data.floID))
        res.status(INVALID.e_code).send(INVALID.str(eCode.ACCESS_DENIED, "Access Denied"));
    else processRequest(res, data.floID, data.pubKey, data.sign, "Remove user-tag", {
        type: "remove_tag",
        user: data.user,
        tag: data.tag,
        timestamp: data.timestamp
    }, () => market.removeTag(data.user, data.tag));
}

function AddDistributor(req, res) {
    let data = req.body;
    if (!trustedIDs.includes(data.floID))
        res.status(INVALID.e_code).send(INVALID.str(eCode.ACCESS_DENIED, "Access Denied"));
    else processRequest(res, data.floID, data.pubKey, data.sign, "Add distributor", {
        type: "add_distributor",
        distributor: data.distributor,
        asset: data.asset,
        timestamp: data.timestamp
    }, () => market.addDistributor(data.distributor, data.asset));
}

function RemoveDistributor(req, res) {
    let data = req.body;
    if (!trustedIDs.includes(data.floID))
        res.status(INVALID.e_code).send(INVALID.str(eCode.ACCESS_DENIED, "Access Denied"));
    else processRequest(res, data.floID, data.pubKey, data.sign, "Remove distributor", {
        type: "remove_distributor",
        distributor: data.distributor,
        asset: data.asset,
        timestamp: data.timestamp
    }, () => market.removeDistributor(data.distributor, data.asset));
}

function ConvertTo(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Conversion", {
        type: "convert_to",
        coin: data.coin,
        txid: data.txid,
        timestamp: data.timestamp
    }, () => conversion.convertToCoin(data.floID, data.txid, data.coin));
}

function ConvertFrom(req, res) {
    let data = req.body;
    processRequest(res, data.floID, data.pubKey, data.sign, "Conversion", {
        type: "convert_from",
        coin: data.coin,
        txid: data.txid,
        timestamp: data.timestamp
    }, () => conversion.convertFromCoin(data.floID, data.txid, data.coin));
}

function CloseBlockchainBond(req, res) {
    let data = req.body;
    if (!data.pubKey)
        res.status(INVALID.e_code).send(INVALID.str(eCode.MISSING_PARAMETER, "Public key missing"));
    else
        processRequest(res, data.floID, data.pubKey, data.sign, "Conversion", {
            type: "close_blockchain_bond",
            bond_id: data.bond_id,
            timestamp: data.timestamp
        }, () => blokchain_bonds.closeBond(data.bond_id, data.floID, `${data.timestamp}.${data.sign}`));
}

/* Public Requests */

function GetLoginCode(req, res) {
    if (!serving)
        res.status(INVALID.e_code).send(INCORRECT_SERVER_ERROR.toString());
    else {
        let randID = floCrypto.randString(8, true) + Math.round(Date.now() / 1000);
        let hash = Crypto.SHA1(randID + secret);
        res.send({
            code: randID,
            hash: hash
        });
    }
}

function ListSellOrders(req, res) {
    if (!serving)
        res.status(INVALID.e_code).send(INCORRECT_SERVER_ERROR.toString());
    else {
        let asset = req.query.asset;
        if (asset && !market.assetList.includes(asset))
            res.status(INVALID.e_code).send(INVALID.str(eCode.INVALID_TOKEN_NAME, "Invalid asset parameter"));
        else
            DB.query("SELECT SellOrder.floID, SellOrder.asset, SellOrder.minPrice, SellOrder.quantity, SellOrder.time_placed FROM SellOrder" +
                " INNER JOIN UserBalance ON UserBalance.floID = SellOrder.floID AND UserBalance.token = SellOrder.asset" +
                " INNER JOIN SellChips ON SellChips.floID = SellOrder.floID AND SellChips.asset = SellOrder.asset" +
                " LEFT JOIN UserTag ON UserTag.floID = SellOrder.floID" +
                " LEFT JOIN TagList ON TagList.tag = UserTag.tag" +
                " WHERE UserBalance.quantity >= SellOrder.quantity" +
                (asset ? " AND SellOrder.asset = ?" : "") +
                " GROUP BY SellOrder.id" +
                " ORDER BY MAX(TagList.sellPriority) DESC, MIN(SellChips.locktime) ASC, SellOrder.time_placed ASC" +
                " LIMIT 100", [asset || null])
                .then(result => res.send(result))
                .catch(error => {
                    console.error(error);
                    res.status(INTERNAL.e_code).send(INTERNAL.str("Try again later!"));
                });
    }

}

function ListBuyOrders(req, res) {
    if (!serving)
        res.status(INVALID.e_code).send(INCORRECT_SERVER_ERROR.toString());
    else {
        let asset = req.query.asset;
        if (asset && !market.assetList.includes(asset))
            res.status(INVALID.e_code).send(INVALID.str(eCode.INVALID_TOKEN_NAME, "Invalid asset parameter"));
        else
            DB.query("SELECT BuyOrder.floID, BuyOrder.asset, BuyOrder.maxPrice, BuyOrder.quantity, BuyOrder.time_placed FROM BuyOrder" +
                " INNER JOIN UserBalance ON UserBalance.floID = BuyOrder.floID AND UserBalance.token = ?" +
                " LEFT JOIN UserTag ON UserTag.floID = BuyOrder.floID" +
                " LEFT JOIN TagList ON TagList.tag = UserTag.tag" +
                " WHERE UserBalance.quantity >= BuyOrder.maxPrice * BuyOrder.quantity" +
                (asset ? " AND BuyOrder.asset = ?" : "") +
                " GROUP BY BuyOrder.id" +
                " ORDER BY MAX(TagList.buyPriority) DESC, BuyOrder.time_placed ASC" +
                " LIMIT 100", [floGlobals.currency, asset || null])
                .then(result => res.send(result))
                .catch(error => {
                    console.error(error);
                    res.status(INTERNAL.e_code).send(INTERNAL.str("Try again later!"));
                });
    }
}

function ListTradeTransactions(req, res) {
    if (!serving)
        res.status(INVALID.e_code).send(INCORRECT_SERVER_ERROR.toString());
    else {
        let asset = req.query.asset;
        if (asset && !market.assetList.includes(asset))
            res.status(INVALID.e_code).send(INVALID.str(eCode.INVALID_TOKEN_NAME, "Invalid asset parameter"));
        else
            DB.query("SELECT * FROM TradeTransactions" +
                (asset ? " WHERE asset = ?" : "") +
                " ORDER BY tx_time DESC LIMIT 1000", [asset || null])
                .then(result => res.send(result))
                .catch(error => {
                    console.error(error);
                    res.status(INTERNAL.e_code).send(INTERNAL.str("Try again later!"));
                });
    }
}

function GetRates(req, res) {
    if (!serving)
        res.status(INVALID.e_code).send(INCORRECT_SERVER_ERROR.toString());
    else {
        let asset = req.query.asset,
            rates = market.rates,
            countDown = market.priceCountDown;
        if (asset) {
            if (asset in rates)
                res.send({
                    asset: asset,
                    rate: rates[asset],
                    countDown: countDown[asset]
                });
            else
                res.status(INVALID.e_code).send(INVALID.str(eCode.INVALID_TOKEN_NAME, "Invalid asset parameter"));
        } else
            res.send({
                rates,
                countDown
            });
    }
}

function GetRateHistory(req, res) {
    if (!serving)
        res.status(INVALID.e_code).send(INCORRECT_SERVER_ERROR.toString());
    else {
        let asset = req.query.asset,
            duration = req.query.duration || "";
        market.getRateHistory(asset, duration)
            .then(result => res.send(result))
            .catch(error => {
                if (error instanceof INVALID)
                    res.status(INVALID.e_code).send(error.toString());
                else {
                    console.error(error);
                    res.status(INTERNAL.e_code).send(INTERNAL.str("Unable to process! Try again later!"));
                }
            });
    }
}

function GetTransaction(req, res) {
    if (!serving)
        res.status(INVALID.e_code).send(INCORRECT_SERVER_ERROR.toString());
    else {
        let txid = req.query.txid;
        if (!txid)
            res.status(INVALID.e_code).send(INVALID.str(eCode.MISSING_PARAMETER, "txid (transactionID) parameter missing"));
        else market.getTransactionDetails(txid)
            .then(result => res.send(result))
            .catch(error => {
                if (error instanceof INVALID)
                    res.status(INVALID.e_code).send(error.toString());
                else {
                    console.error(error);
                    res.status(INTERNAL.e_code).send(INTERNAL.str("Unable to process! Try again later!"));
                }
            });
    }
}

function GetBalance(req, res) {
    if (!serving)
        res.status(INVALID.e_code).send(INCORRECT_SERVER_ERROR.toString());
    else {
        let floID = req.query.floID || req.query.addr,
            token = req.query.token || req.query.asset;
        market.getBalance(floID, token)
            .then(result => res.send(result))
            .catch(error => {
                if (error instanceof INVALID)
                    res.status(INVALID.e_code).send(error.toString());
                else {
                    console.error(error);
                    res.status(INTERNAL.e_code).send(INTERNAL.str("Unable to process! Try again later!"));
                }
            });
    }
}

module.exports = {
    GetLoginCode,
    Login,
    Logout,
    PlaceBuyOrder,
    PlaceSellOrder,
    CancelOrder,
    TransferToken,
    ListSellOrders,
    ListBuyOrders,
    ListTradeTransactions,
    GetRates,
    GetRateHistory,
    GetTransaction,
    GetBalance,
    Account,
    DepositFLO,
    WithdrawFLO,
    DepositToken,
    WithdrawToken,
    GetUserTransacts,
    AddUserTag,
    RemoveUserTag,
    AddDistributor,
    RemoveDistributor,
    ConvertTo,
    ConvertFrom,
    CloseBlockchainBond,
    set trustedIDs(ids) {
        trustedIDs = ids;
    },
    set assetList(assets) {
        market.assetList = assets;
    },
    set chests(c) {
        market.chests = c;
    },
    set collectAndCall(fn) {
        market.collectAndCall = fn;
    },
    set DB(db) {
        DB = db;
        market.DB = db;
        conversion.DB;
        blokchain_bonds.DB;
    },
    set secret(s) {
        secret = s;
    },
    pause() {
        serving = false;
        market.periodicProcess.stop();
    },
    resume() {
        serving = true;
        market.periodicProcess.start();
    }
};