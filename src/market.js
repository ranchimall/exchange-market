'use strict';

const coupling = require('./coupling');
const background = require('./background');
const DB = require("./database");

const blockchain = background.blockchain;

const {
    PERIOD_INTERVAL,
    WAIT_TIME,
    TRADE_HASH_PREFIX,
    TRANSFER_HASH_PREFIX
} = require('./_constants')["market"];

const eCode = require('../docs/scripts/floExchangeAPI').errorCode;
const pCode = require('../docs/scripts/floExchangeAPI').processCode;

const updateBalance = background.updateBalance = coupling.updateBalance;

var assetList; //container for allowed assets

function login(floID, proxyKey) {
    return new Promise((resolve, reject) => {
        DB.query("INSERT INTO UserSession (floID, proxyKey) VALUE (?) ON DUPLICATE KEY UPDATE session_time=DEFAULT, proxyKey=?", [[floID, proxyKey], proxyKey])
            .then(result => resolve("Login Successful"))
            .catch(error => reject(error))
    })
}

function logout(floID) {
    return new Promise((resolve, reject) => {
        DB.query("DELETE FROM UserSession WHERE floID=?", [floID])
            .then(result => resolve("Logout successful"))
            .catch(error => reject(error))
    })
}

function getRateHistory(asset, duration) {
    return new Promise((resolve, reject) => {
        if (!asset || !assetList.includes(asset))
            reject(INVALID(eCode.INVALID_TOKEN_NAME, `Invalid asset(${asset})`));
        else
            coupling.price.getHistory(asset, duration)
                .then(result => resolve(result))
                .catch(error => reject(error))
    })
}

function getBalance(floID, token) {
    return new Promise((resolve, reject) => {
        if (floID && !floCrypto.validateAddr(floID))
            reject(INVALID(eCode.INVALID_FLO_ID, `Invalid floID(${floID})`));
        else if (token && token !== floGlobals.currency && !assetList.includes(token))
            reject(INVALID(eCode.INVALID_TOKEN_NAME, `Invalid token(${token})`));
        else if (!floID && !token)
            reject(INVALID(eCode.MISSING_PARAMETER, 'Missing parameters: requires atleast one (floID, token)'));
        else {
            var promise;
            if (floID && token)
                promise = getBalance.floID_token(floID, token);
            else if (floID)
                promise = getBalance.floID(floID);
            else if (token)
                promise = getBalance.token(token);
            promise.then(result => resolve(result)).catch(error => reject(error))
        }
    })
}

getBalance.floID_token = (floID, token) => new Promise((resolve, reject) => {
    DB.query("SELECT quantity AS balance FROM UserBalance WHERE floID=? AND token=?", [floID, token]).then(result => resolve({
        floID,
        token,
        balance: result.length ? global.toStandardDecimal(result[0].balance) : 0
    })).catch(error => reject(error))
});

getBalance.floID = (floID) => new Promise((resolve, reject) => {
    DB.query("SELECT token, quantity AS balance FROM UserBalance WHERE floID=?", [floID]).then(result => {
        let response = {
            floID,
            balance: {}
        };
        for (let row of result)
            response.balance[row.token] = global.toStandardDecimal(row.balance);
        resolve(response);
    }).catch(error => reject(error))
});

getBalance.token = (token) => new Promise((resolve, reject) => {
    DB.query("SELECT floID, quantity AS balance FROM UserBalance WHERE token=?", [token]).then(result => {
        let response = {
            token: token,
            balance: {}
        };
        for (let row of result)
            response.balance[row.floID] = global.toStandardDecimal(row.balance);
        resolve(response);
    }).catch(error => reject(error))
});

const getAssetBalance = (floID, asset) => new Promise((resolve, reject) => {
    let promises = [];
    promises.push(DB.query("SELECT IFNULL(SUM(quantity), 0) AS balance FROM UserBalance WHERE floID=? AND token=?", [floID, asset]));
    promises.push(asset === floGlobals.currency ?
        DB.query("SELECT IFNULL(SUM(quantity*maxPrice), 0) AS locked FROM BuyOrder WHERE floID=?", [floID]) :
        DB.query("SELECT IFNULL(SUM(quantity), 0) AS locked FROM SellOrder WHERE floID=? AND asset=?", [floID, asset])
    );
    Promise.all(promises).then(result => resolve({
        total: result[0][0].balance,
        locked: result[1][0].locked,
        net: result[0][0].balance - result[1][0].locked
    })).catch(error => reject(error))
});

getAssetBalance.check = (floID, asset, amount) => new Promise((resolve, reject) => {
    getAssetBalance(floID, asset).then(balance => {
        if (balance.total < amount)
            reject(INVALID(eCode.INSUFFICIENT_BALANCE, `Insufficient ${asset}`));
        else if (balance.net < amount)
            reject(INVALID(eCode.INSUFFICIENT_BALANCE, `Insufficient ${asset} (Some are locked in orders)`));
        else
            resolve(true);
    }).catch(error => reject(error))
});

function addSellOrder(floID, asset, quantity, min_price) {
    return new Promise((resolve, reject) => {
        if (!floCrypto.validateAddr(floID))
            return reject(INVALID(eCode.INVALID_FLO_ID, `Invalid floID (${floID})`));
        else if (typeof quantity !== "number" || quantity <= 0)
            return reject(INVALID(eCode.INVALID_NUMBER, `Invalid quantity (${quantity})`));
        else if (typeof min_price !== "number" || min_price <= 0)
            return reject(INVALID(eCode.INVALID_NUMBER, `Invalid min_price (${min_price})`));
        else if (!assetList.includes(asset))
            return reject(INVALID(eCode.INVALID_TOKEN_NAME, `Invalid asset (${asset})`));
        getAssetBalance.check(floID, asset, quantity).then(_ => {
            checkSellRequirement(floID, asset, quantity, min_price).then(_ => {
                DB.query("INSERT INTO SellOrder(floID, asset, quantity, minPrice) VALUES (?)", [[floID, asset, quantity, min_price]]).then(result => {
                    resolve('Sell Order placed successfully');
                    coupling.initiate(asset);
                }).catch(error => reject(error));
            }).catch(error => reject(error))
        }).catch(error => reject(error));
    });
}

const checkSellRequirement = (floID, asset, quantity, min_price) => new Promise((resolve, reject) => {
    Promise.all([
        DB.query("SELECT IFNULL(SUM(quantity), 0) AS total_chips FROM SellChips WHERE floID=? AND asset=?", [floID, asset]),
        DB.query("SELECT IFNULL(SUM(quantity), 0) AS locked FROM SellOrder WHERE floID=? AND asset=?", [floID, asset])
    ]).then(result => {
        let total = result[0][0].total_chips,
            locked = result[1][0].locked;
        if (total < locked + quantity)
            reject(INVALID(eCode.INSUFFICIENT_SELLCHIP, `Insufficient sell-chips for ${asset}`));
        else Promise.all([
            DB.query("SELECT IFNULL(SUM(quantity), 0) AS total_chips FROM SellChips WHERE floID=? AND asset=? AND base<=?", [floID, asset, min_price]),
            DB.query("SELECT IFNULL(SUM(quantity), 0) AS locked FROM SellOrder WHERE floID=? AND asset=? AND minPrice<=?", [floID, asset, min_price])
        ]).then(result => {
            let g_total = result[0][0].total_chips,
                g_locked = result[1][0].locked;
            let l_total = total - g_total,
                l_locked = locked - g_locked;
            var rem = g_total - g_locked;
            if (l_locked > l_total)
                rem -= l_locked - l_total;
            if (rem < quantity)
                reject(INVALID(eCode.GREATER_SELLCHIP_BASE, `Cannot sell below purchased price`));
            else
                resolve(true);
        }).catch(error => reject(error))
    }).catch(error => reject(error))
});

function addBuyOrder(floID, asset, quantity, max_price) {
    return new Promise((resolve, reject) => {
        if (!floCrypto.validateAddr(floID))
            return reject(INVALID(eCode.INVALID_FLO_ID, `Invalid floID (${floID})`));
        else if (typeof quantity !== "number" || quantity <= 0)
            return reject(INVALID(eCode.INVALID_NUMBER, `Invalid quantity (${quantity})`));
        else if (typeof max_price !== "number" || max_price <= 0)
            return reject(INVALID(eCode.INVALID_NUMBER, `Invalid max_price (${max_price})`));
        else if (!assetList.includes(asset))
            return reject(INVALID(eCode.INVALID_TOKEN_NAME, `Invalid asset (${asset})`));
        getAssetBalance.check(floID, floGlobals.currency, quantity * max_price).then(_ => {
            DB.query("INSERT INTO BuyOrder(floID, asset, quantity, maxPrice) VALUES (?)", [[floID, asset, quantity, max_price]]).then(result => {
                resolve('Buy Order placed successfully');
                coupling.initiate(asset);
            }).catch(error => reject(error));
        }).catch(error => reject(error));
    });
}

function cancelOrder(type, id, floID) {
    return new Promise((resolve, reject) => {
        if (!floCrypto.validateAddr(floID))
            return reject(INVALID(eCode.INVALID_FLO_ID, `Invalid floID (${floID})`));
        let tableName;
        if (type === "buy")
            tableName = "BuyOrder";
        else if (type === "sell")
            tableName = "SellOrder";
        else
            return reject(INVALID(eCode.INVALID_TYPE, "Invalid Order type! Order type must be buy (or) sell"));
        DB.query(`SELECT floID, asset FROM ${tableName} WHERE id=?`, [id]).then(result => {
            if (result.length < 1)
                return reject(INVALID(eCode.NOT_FOUND, "Order not found!"));
            else if (result[0].floID !== floID)
                return reject(INVALID(eCode.NOT_OWNER, "Order doesnt belong to the current user"));
            let asset = result[0].asset;
            //Delete the order 
            DB.query(`DELETE FROM ${tableName} WHERE id=?`, [id]).then(result => {
                resolve(tableName + "#" + id + " cancelled successfully");
                coupling.initiate(asset);
            }).catch(error => reject(error));
        }).catch(error => reject(error));
    });
}

function getAccountDetails(floID) {
    return new Promise((resolve, reject) => {
        let select = [];
        select.push(["token, quantity", "UserBalance"]);
        select.push(["id, asset, quantity, minPrice, time_placed", "SellOrder"]);
        select.push(["id, asset, quantity, maxPrice, time_placed", "BuyOrder"]);
        let promises = select.map(a => DB.query(`SELECT ${a[0]} FROM ${a[1]} WHERE floID=? ${a[2] || ""}`, [floID]));
        Promise.allSettled(promises).then(results => {
            let response = {
                floID: floID,
                time: Date.now()
            };
            results.forEach((a, i) => {
                if (a.status === "rejected")
                    console.error(a.reason);
                else
                    switch (i) {
                        case 0:
                            response.tokenBalance = a.value;
                            break;
                        case 1:
                            response.sellOrders = a.value;
                            break;
                        case 2:
                            response.buyOrders = a.value;
                            break;
                    }
            });
            DB.query("SELECT * FROM TradeTransactions WHERE seller=? OR buyer=?", [floID, floID])
                .then(result => response.transactions = result)
                .catch(error => console.error(error))
                .finally(_ => resolve(response));
        });
    });
}

function getUserTransacts(floID) {
    return new Promise((resolve, reject) => {
        DB.query("SELECT mode, asset, amount, txid, locktime, r_status FROM VaultTransactions WHERE floID=?", [floID])
            .then(result => resolve(result))
            .catch(error => reject(error))
    })
}

function getTransactionDetails(txid) {
    return new Promise((resolve, reject) => {
        let tableName, type;
        if (txid.startsWith(TRANSFER_HASH_PREFIX)) {
            tableName = 'TransferTransactions';
            type = 'transfer';
        } else if (txid.startsWith(TRADE_HASH_PREFIX)) {
            tableName = 'TradeTransactions';
            type = 'trade';
        } else
            return reject(INVALID(eCode.INVALID_TX_ID, "Invalid TransactionID"));
        DB.query(`SELECT * FROM ${tableName} WHERE txid=?`, [txid]).then(result => {
            if (result.length) {
                let details = result[0];
                details.type = type;
                if (tableName === 'TransferTransactions') //As json object is stored for receiver in transfer (to support one-to-many)
                    details.receiver = JSON.parse(details.receiver);
                resolve(details);
            } else
                reject(INVALID(eCode.NOT_FOUND, "Transaction not found"));
        }).catch(error => reject(error))
    })
}

function transferToken(sender, receivers, token) {
    return new Promise((resolve, reject) => {
        if (!floCrypto.validateAddr(sender))
            reject(INVALID(eCode.INVALID_FLO_ID, `Invalid sender (${sender})`));
        else if (token !== floGlobals.currency && !assetList.includes(token))
            reject(INVALID(eCode.INVALID_TOKEN_NAME, `Invalid token (${token})`));
        else {
            let invalidIDs = [],
                totalAmount = 0;
            for (let floID in receivers)
                if (!floCrypto.validateAddr(floID))
                    invalidIDs.push(floID);
                else
                    totalAmount += receivers[floID];
            if (invalidIDs.length)
                reject(INVALID(eCode.INVALID_FLO_ID, `Invalid receiver (${invalidIDs})`));
            else getAssetBalance.check(sender, token, totalAmount).then(_ => {
                let txQueries = [];
                txQueries.push(updateBalance.consume(sender, token, totalAmount));
                for (let floID in receivers)
                    txQueries.push(updateBalance.add(floID, token, receivers[floID]));
                checkDistributor(sender, token).then(result => {
                    if (result)
                        for (let floID in receivers)
                            txQueries.push(["INSERT INTO SellChips (floID, asset, quantity) VALUES (?)", [[floID, token, receivers[floID]]]]);
                    let time = Date.now();
                    let hash = TRANSFER_HASH_PREFIX + Crypto.SHA256(JSON.stringify({
                        sender: sender,
                        receiver: receivers,
                        token: token,
                        totalAmount: totalAmount,
                        tx_time: time,
                    }));
                    txQueries.push([
                        "INSERT INTO TransferTransactions (sender, receiver, token, totalAmount, tx_time, txid) VALUE (?)",
                        [[sender, JSON.stringify(receivers), token, totalAmount, new Date(time), hash]]
                    ]);
                    DB.transaction(txQueries)
                        .then(result => resolve(hash))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        }
    })
}

function depositFLO(floID, txid) {
    return new Promise((resolve, reject) => {
        DB.query("SELECT r_status FROM VaultTransactions WHERE txid=? AND floID=? AND asset=?", [txid, floID, "FLO"]).then(result => {
            if (result.length) {
                switch (result[0].r_status) {
                    case pCode.STATUS_PENDING:
                        return reject(INVALID(eCode.DUPLICATE_ENTRY, "Transaction already in process"));
                    case pCode.STATUS_REJECTED:
                        return reject(INVALID(eCode.DUPLICATE_ENTRY, "Transaction already rejected"));
                    case pCode.STATUS_SUCCESS:
                        return reject(INVALID(eCode.DUPLICATE_ENTRY, "Transaction already used to add coins"));
                }
            } else
                DB.query("INSERT INTO VaultTransactions(floID, mode, asset_type, asset, txid, r_status) VALUES (?)", [[floID, pCode.VAULT_MODE_DEPOSIT, pCode.ASSET_TYPE_COIN, "FLO", txid, pCode.STATUS_PENDING]])
                    .then(result => resolve("Deposit request in process"))
                    .catch(error => reject(error));
        }).catch(error => reject(error))
    });
}

function withdrawFLO(floID, amount) {
    return new Promise((resolve, reject) => {
        if (!floCrypto.validateAddr(floID))
            return reject(INVALID(eCode.INVALID_FLO_ID, `Invalid floID (${floID})`));
        else if (typeof amount !== "number" || amount <= 0)
            return reject(INVALID(eCode.INVALID_NUMBER, `Invalid amount (${amount})`));
        getAssetBalance.check(floID, "FLO", amount).then(_ => {
            let txQueries = [];
            txQueries.push(updateBalance.consume(floID, "FLO", amount));
            DB.transaction(txQueries).then(result => {
                blockchain.withdrawAsset.init(floID, "FLO", amount);
                resolve("Withdrawal request is in process");
            }).catch(error => reject(error));
        }).catch(error => reject(error));
    });
}

function depositToken(floID, txid) {
    return new Promise((resolve, reject) => {
        DB.query("SELECT r_status FROM VaultTransactions WHERE txid=? AND floID=? AND asset_type=?", [txid, floID, pCode.ASSET_TYPE_TOKEN]).then(result => {
            if (result.length) {
                switch (result[0].r_status) {
                    case pCode.STATUS_PENDING:
                        return reject(INVALID(eCode.DUPLICATE_ENTRY, "Transaction already in process"));
                    case pCode.STATUS_REJECTED:
                        return reject(INVALID(eCode.DUPLICATE_ENTRY, "Transaction already rejected"));
                    case pCode.STATUS_SUCCESS:
                        return reject(INVALID(eCode.DUPLICATE_ENTRY, "Transaction already used to add tokens"));
                }
            } else
                DB.query("INSERT INTO VaultTransactions(floID, mode, asset_type, txid, r_status) VALUES (?)", [[floID, pCode.VAULT_MODE_DEPOSIT, pCode.ASSET_TYPE_TOKEN, txid, pCode.STATUS_PENDING]])
                    .then(result => resolve("Deposit request in process"))
                    .catch(error => reject(error));
        }).catch(error => reject(error))
    });
}

function withdrawToken(floID, token, amount) {
    return new Promise((resolve, reject) => {
        if (!floCrypto.validateAddr(floID))
            return reject(INVALID(eCode.INVALID_FLO_ID, `Invalid floID (${floID})`));
        else if (typeof amount !== "number" || amount <= 0)
            return reject(INVALID(eCode.INVALID_NUMBER, `Invalid amount (${amount})`));
        else if ((!assetList.includes(token) && token !== floGlobals.currency) || token === "FLO")
            return reject(INVALID(eCode.INVALID_TOKEN_NAME, "Invalid Token"));
        //Check for FLO balance (transaction fee)
        let required_flo = floGlobals.sendAmt + floGlobals.fee;
        getAssetBalance.check(floID, "FLO", required_flo).then(_ => {
            getAssetBalance.check(floID, token, amount).then(_ => {
                let txQueries = [];
                txQueries.push(updateBalance.consume(floID, "FLO", required_flo));
                txQueries.push(updateBalance.consume(floID, token, amount));
                DB.transaction(txQueries).then(result => {
                    //Send Token to user via token API
                    blockchain.withdrawAsset.init(floID, token, amount);
                    resolve("Withdrawal request is in process");
                }).catch(error => reject(error));
            }).catch(error => reject(error));
        }).catch(error => reject(error));
    });
}

function addTag(floID, tag) {
    return new Promise((resolve, reject) => {
        DB.query("INSERT INTO UserTag (floID, tag) VALUE (?)", [[floID, tag]])
            .then(result => resolve(`Added ${floID} to ${tag}`))
            .catch(error => {
                if (error.code === "ER_DUP_ENTRY")
                    reject(INVALID(eCode.DUPLICATE_ENTRY, `${floID} already in ${tag}`));
                else if (error.code === "ER_NO_REFERENCED_ROW")
                    reject(INVALID(eCode.INVALID_TAG, `Invalid Tag`));
                else
                    reject(error);
            });
    });
}

function removeTag(floID, tag) {
    return new Promise((resolve, reject) => {
        DB.query("DELETE FROM UserTag WHERE floID=? AND tag=?", [floID, tag])
            .then(result => resolve(`Removed ${floID} from ${tag}`))
            .catch(error => reject(error));
    })
}

function addDistributor(floID, asset) {
    return new Promise((resolve, reject) => {
        DB.query("INSERT INTO Distributors (floID, asset) VALUE (?)", [[floID, asset]])
            .then(result => resolve(`Added ${asset} distributor: ${floID}`))
            .catch(error => {
                if (error.code === "ER_DUP_ENTRY")
                    reject(INVALID(eCode.DUPLICATE_ENTRY, `${floID} is already ${asset} disributor`));
                else if (error.code === "ER_NO_REFERENCED_ROW")
                    reject(INVALID(eCode.INVALID_TOKEN_NAME, `Invalid Asset`));
                else
                    reject(error);
            });
    });
}

function removeDistributor(floID, asset) {
    return new Promise((resolve, reject) => {
        DB.query("DELETE FROM Distributors WHERE floID=? AND tag=?", [floID, asset])
            .then(result => resolve(`Removed ${asset} distributor: ${floID}`))
            .catch(error => reject(error));
    })
}

function checkDistributor(floID, asset) {
    return new Promise((resolve, reject) => {
        DB.query("SELECT id FROM Distributors WHERE floID=? AND asset=?", [floID, asset])
            .then(result => resolve(result.length ? true : false))
            .catch(error => reject(error))
    })
}

//Periodic Process

function periodicProcess_start() {
    periodicProcess_stop();
    periodicProcess();
    assetList.forEach(asset => coupling.initiate(asset, true));
    coupling.price.storeHistory.start();
    periodicProcess.instance = setInterval(periodicProcess, PERIOD_INTERVAL);
}

function periodicProcess_stop() {
    if (periodicProcess.instance !== undefined) {
        clearInterval(periodicProcess.instance);
        delete periodicProcess.instance;
    }
    coupling.stopAll();
    coupling.price.storeHistory.stop();
};

var lastSyncBlockHeight = 0;

function periodicProcess() {
    if (periodicProcess.timeout !== undefined) {
        clearTimeout(periodicProcess.timeout);
        delete periodicProcess.timeout;
    }
    if (!blockchain.chests.list.length)
        return periodicProcess.timeout = setTimeout(periodicProcess, WAIT_TIME);

    floBlockchainAPI.promisedAPI('api/blocks?limit=1').then(result => {
        if (lastSyncBlockHeight < result.blocks[0].height) {
            lastSyncBlockHeight = result.blocks[0].height;
            background.process();
            console.log("Last Block :", lastSyncBlockHeight);
        }
    }).catch(error => console.error(error));
}

module.exports = {
    login,
    logout,
    get rates() {
        return coupling.price.currentRates;
    },
    get priceCountDown() {
        return coupling.price.lastTimes;
    },
    get chests() {
        return blockchain.chests;
    },
    set chests(c) {
        blockchain.chests = c;
    },
    addBuyOrder,
    addSellOrder,
    cancelOrder,
    getRateHistory,
    getBalance,
    getAccountDetails,
    getUserTransacts,
    getTransactionDetails,
    transferToken,
    depositFLO,
    withdrawFLO,
    depositToken,
    withdrawToken,
    addTag,
    removeTag,
    addDistributor,
    removeDistributor,
    periodicProcess: {
        start: periodicProcess_start,
        stop: periodicProcess_stop
    },
    set assetList(assets) {
        assetList = assets;
        background.assetList = assets;
    },
    get assetList() {
        return assetList
    },
    set collectAndCall(fn) {
        blockchain.collectAndCall = fn;
    },
};