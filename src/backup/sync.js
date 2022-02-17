'use strict';

const {
    HASH_N_ROW
} = require("../_constants")["backup"];

var DB; //Container for database

//Backup Transfer
function sendBackupData(timestamp, checksum, ws) {
    if (!timestamp) timestamp = 0;
    else if (typeof timestamp === "string" && /\.\d{3}Z$/.test(timestamp))
        timestamp = timestamp.substring(0, timestamp.length - 1);
    let promises = [
        backupSync_data(timestamp, ws),
        backupSync_delete(timestamp, ws)
    ];
    if (checksum)
        promises.push(backupSync_checksum(ws));
    Promise.allSettled(promises).then(result => {
        let failedSync = [];
        result.forEach(r => r.status === "rejected" ? failedSync.push(r.reason) : null);
        if (failedSync.length) {
            console.info("Backup Sync Failed:", failedSync);
            ws.send(JSON.stringify({
                command: "SYNC_END",
                status: false,
                info: failedSync
            }));
        } else {
            console.info("Backup Sync completed");
            ws.send(JSON.stringify({
                command: "SYNC_END",
                status: true
            }));
        }
    });
}

function backupSync_delete(timestamp, ws) {
    return new Promise((resolve, reject) => {
        DB.query("SELECT * FROM _backup WHERE mode is NULL AND timestamp > ?", [timestamp]).then(result => {
            ws.send(JSON.stringify({
                command: "SYNC_DELETE",
                delete_data: result
            }));
            resolve("deleteSync");
        }).catch(error => {
            console.error(error);
            reject("deleteSync");
        });
    })
}

function backupSync_data(timestamp, ws) {
    const sendTable = (table, id_list) => new Promise((res, rej) => {
        DB.query(`SELECT * FROM ${table} WHERE id IN (${id_list})`)
            .then(data => {
                ws.send(JSON.stringify({
                    table,
                    command: "SYNC_UPDATE",
                    data
                }));
                res(table);
            }).catch(error => {
                console.error(error);
                rej(table);
            });
    });
    return new Promise((resolve, reject) => {
        DB.query("SELECT * FROM _backup WHERE mode=TRUE AND timestamp > ?", [timestamp]).then(result => {
            let sync_needed = {};
            result.forEach(r => r.t_name in sync_needed ? sync_needed[r.t_name].push(r.id) : sync_needed[r.t_name] = [r.id]);
            ws.send(JSON.stringify({
                command: "SYNC_HEADER",
                add_data: result
            }));
            let promises = [];
            for (let table in sync_needed)
                promises.push(sendTable(table, sync_needed[table]));
            Promise.allSettled(promises).then(result => {
                let failedTables = [];
                result.forEach(r => r.status === "rejected" ? failedTables.push(r.reason) : null);
                if (failedTables.length)
                    reject(["dataSync", failedTables]);
                else
                    resolve("dataSync");
            });
        }).catch(error => {
            console.error(error);
            reject("dataSync");
        });
    });
}

function backupSync_checksum(ws) {
    return new Promise((resolve, reject) => {
        DB.query("SELECT DISTINCT t_name FROM _backup").then(result => {
            let tableList = result.map(r => r['t_name']);
            DB.query("CHECKSUM TABLE " + tableList.join()).then(result => {
                let checksum = Object.fromEntries(result.map(r => [r.Table.split(".").pop(), r.Checksum]));
                ws.send(JSON.stringify({
                    command: "SYNC_CHECKSUM",
                    checksum: checksum
                }));
                resolve("checksum");
            }).catch(error => {
                console.error(error);
                reject("checksum");
            })
        }).catch(error => {
            console.error(error);
            reject("checksum");
        })
    })

}

function sendTableHash(tables, ws) {
    const getHash = table => new Promise((res, rej) => {
        DB.query("SHOW COLUMNS FROM " + table).then(result => {
            let columns = result.map(r => r["Field"]).sort();
            DB.query(`SELECT CEIL(id/${HASH_N_ROW}) as group_id, MD5(GROUP_CONCAT(${columns.map(c => `IFNULL(${c}, "NULL")`).join()})) as hash FROM ${table} GROUP BY group_id ORDER BY group_id`)
                .then(result => res(Object.fromEntries(result.map(r => [r.group_id, r.hash]))))
                .catch(error => rej(error))
        }).catch(error => rej(error))
    });
    Promise.allSettled(tables.map(t => getHash(t))).then(result => {
        let hashes = {};
        for (let i in tables)
            if (result[i].status === "fulfilled")
                hashes[tables[i]] = result[i].value;
            else
                console.error(result[i].reason);
        ws.send(JSON.stringify({
            command: "SYNC_HASH",
            hashes: hashes
        }));
    })
}

function sendTableData(tables, ws) {
    let promises = [
        tableSync_data(tables, ws),
        tableSync_delete(tables, ws),
        tableSync_checksum(Object.keys(tables), ws)
    ];
    Promise.allSettled(promises).then(result => {
        let failedSync = [];
        result.forEach(r => r.status === "rejected" ? failedSync.push(r.reason) : null);
        if (failedSync.length) {
            console.info("Backup Sync Failed:", failedSync);
            ws.send(JSON.stringify({
                command: "SYNC_END",
                status: false,
                info: failedSync
            }));
        } else {
            console.info("Backup Sync completed");
            ws.send(JSON.stringify({
                command: "SYNC_END",
                status: true
            }));
        }
    });
}

function tableSync_delete(tables, ws) {
    let getDelete = (table, group_id) => new Promise((res, rej) => {
        let id_end = group_id * HASH_N_ROW,
            id_start = id_end - HASH_N_ROW + 1;
        DB.query("SELECT * FROM _backup WHERE t_name=? AND mode is NULL AND (id BETWEEN ? AND ?)", [table, id_start, id_end])
            .then(result => res(result))
            .catch(error => rej(error))
    })
    return new Promise((resolve, reject) => {
        let promises = [];
        for (let t in tables)
            for (let g_id in tables[t][1]) //tables[t] is [convertIntArray(hash_ref), convertIntArray(hash_cur)]
                promises.push(getDelete(t, g_id));
        Promise.allSettled(promises).then(results => {
            let delete_sync = results.filter(r => r.status === "fulfilled").map(r => r.value); //Filtered results
            delete_sync = [].concat(...delete_sync); //Convert 2d array into 1d
            ws.send(JSON.stringify({
                command: "SYNC_DELETE",
                delete_data: delete_sync
            }));
            resolve("deleteSync");
        });
    })
}

function tableSync_data(tables, ws) {
    const sendTable = (table, group_id) => new Promise((res, rej) => {
        let id_end = group_id * HASH_N_ROW,
            id_start = id_end - HASH_N_ROW + 1;
        DB.query(`SELECT * FROM ${table} WHERE id BETWEEN ? AND ?`, [id_start, id_end]).then(data => {
            ws.send(JSON.stringify({
                table,
                command: "SYNC_UPDATE",
                data
            }));
            res(table);
        }).catch(error => {
            console.error(error);
            rej(table);
        });
    });
    const getUpdate = (table, group_id) => new Promise((res, rej) => {
        let id_end = group_id * HASH_N_ROW,
            id_start = id_end - HASH_N_ROW + 1;
        DB.query("SELECT * FROM _backup WHERE t_name=? AND mode=TRUE AND (id BETWEEN ? AND ?)", [table, id_start, id_end])
            .then(result => res(result))
            .catch(error => rej(error))
    })
    return new Promise((resolve, reject) => {
        let promises = [];
        for (let t in tables)
            for (let g_id of tables[t][0]) //tables[t] is [convertIntArray(hash_ref), convertIntArray(hash_cur)]
                promises.push(getUpdate(t, g_id));
        Promise.allSettled(promises).then(results => {
            let update_sync = results.filter(r => r.status === "fulfilled").map(r => r.value); //Filtered results
            update_sync = [].concat(...update_sync); //Convert 2d array into 1d
            ws.send(JSON.stringify({
                command: "SYNC_HEADER",
                add_data: update_sync
            }));
            let promises = [];
            for (let t in tables)
                for (let g_id of tables[t][0]) //tables[t] is [convertIntArray(hash_ref), convertIntArray(hash_cur)]
                    promises.push(sendTable(t, g_id));
            Promise.allSettled(promises).then(result => {
                let failedTables = [];
                result.forEach(r => r.status === "rejected" ? failedTables.push(r.reason) : null);
                if (failedTables.length)
                    reject(["dataSync", [...new Set(failedTables)]]);
                else
                    resolve("dataSync");
            });
        });
    })
}

function tableSync_checksum(tables, ws) {
    return new Promise((resolve, reject) => {
        DB.query("CHECKSUM TABLE " + tables.join()).then(result => {
            let checksum = Object.fromEntries(result.map(r => [r.Table.split(".").pop(), r.Checksum]));
            ws.send(JSON.stringify({
                command: "SYNC_CHECKSUM",
                checksum: checksum
            }));
            resolve("checksum");
        }).catch(error => {
            console.error(error);
            reject("checksum");
        })
    })

}

module.exports = {
    sendBackupData,
    sendTableHash,
    sendTableData,
    set DB(db) {
        DB = db;
    }
}