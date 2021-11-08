const ERR = require('async-stacktrace');
const express = require('express');
const router = express.Router();
const logger = require('../../lib/logger');
const config = require('../../lib/config.js');

const sqldb = require('../../prairielib/lib/sql-db');
const sqlLoader = require('../../prairielib/lib/sql-loader');
const sql = sqlLoader.loadSqlEquiv(__filename);
const bitgener = require('bitgener');
const pdfkit = require('pdfkit');
const sharp = require('sharp');
const jsCrc = require('js-crc');

const generateBarcodes = async (numRows) => {
    const barcodes = [];

    // Barcodes should be error-detecting <8 char hexatridecimal produced by base36 encoding><4 char crc16 hash>
    // Sequential counter to produce 8 char base36 string should be base36 encode input
    // Approx lower and upper bound: 80000000000 - 999999999999; 80 billion to 100 billion

    if (!numRows || numRows > 1000) {
        throw new Error('Cannot produce more than 1000 or less than 1 barcoded sheets');
    }

    // sqldb.beginTransaction((err, client, done) => {
    //     if(err) {
    //         console.log(err);
    //     }

    //     async.series([
    //         (callback) => {
    //             sqldb.queryWithClient(client, sql.get_barcodes_count, {}, (err, result) => {
    //                 if (err) {
    //                     console.log('error 1', err);
    //                 }

    //                 // Do this in application layer to avoid writing crc16 and base36 logic in Postgres
    //                 let numBarcodes = Number(result[1].rows[0].count);
    //                 for (let i = 0; i < numBarcodes; i++) {
    //                     numBarcodes+=1;
    //                     const base36 = BigInt(numBarcodes).toString(36);
    //                     const crc16 = jsCrc.crc16(base36);
    //                     const barcode = `${base36}${crc16}`;
    //                     barcodes.push({barcode}); // concat as string in chance integers combo
    //                 }
    //                 callback(barcodes);
    //             });
    //         },

    //     ], (err) => {
    //         sqldb.endTransaction(client, done, err, (err) => {
    //             if (err) {
    //                 console.log(err);
    //             }
    //             return barcodes;
    //         });
    //     });

        const {client, done} = await sqldb.beginTransactionAsync();
        try {
            const queryCount = await sqldb.queryWithClientAsync(client, sql.get_barcodes_count, {});

            // Want to create new barcodes based on sequential count in database
            let numBarcodes = Number(queryCount[1].rows[0].count);
            for (let i = 0; i < numRows; i++) {
                numBarcodes+=1;
                const base36 = BigInt(numBarcodes).toString(36);
                const crc16 = jsCrc.crc16(base36);
                const barcode = `${base36}${crc16}`;
                barcodes.push(barcode); // concat as string in chance integers combo
            }

            const insert_barcodes = sql.insert_barcodes.replace('$barcodes', barcodes.map(barcode => "('" + barcode + "')")
                .join(','));
            const insertBarcodes = await sqldb.queryWithClientAsync(client, insert_barcodes, {});
            if (insertBarcodes.rows.length !== numRows) {
                throw Error('Wrong number of barcodes created. Aborting');
            }
        } catch (err) {
            // rolls back if error
            await sqldb.endTransactionAsync(client, done, err);
            throw err;
        }
        await sqldb.endTransactionAsync(client, done, null);
        return barcodes;
};


    // sqldb.beginTransaction((err, client, done) => {
    //     if (err) {
    //         console.log(err);
    //     }

    //     async.series([
    //         (callback) => {
    //             let result = sqldb.callWithClient(client, sql.lock_barcodes_exclusive, {}, (err, result) => {
    //                 if (err) return;
    //                 console.log(result);
    //                 callback(result);
    //             });
    //         },
    //     ], (err) => {
    //         sqldb.endTransaction(client, done, err, (err) => {
    //             if (ERR(err, callback)) return;
    //             callback(null, submission_id);
    //         });
    //     });        
        //     console.log('starting transaction');
        // console.log('result 1', result);
        // result = sqldb.callWithClientAsync(client, sql.get_barcodes_count, {});
        // console.log('result 2', result);
        // // Do this in application layer to avoid writing crc16 and base36 logic in Postgres
        // result.rows.forEach(row => {
        //     const id = row.id;
        //     const base36 = BigInt(id).toString(36);
        //     const crc16 = jsCrc.crc16(base36);
        //     const barcode = `${base36}${crc16}`;
        //     barcodes.push({barcode}); // concat as string in chance integers combo
        //     params.barcodes.push([id, barcode]);
        // });

        // const idsUpdate = await sqldb.queryAsync(sql.insert_barcodes, params.barcodes);
    //     console.log('development', barcodes);
    //     return barcodes;
    // });


const createBarcodeSVGs = async (barcodes) => {
    const svgs = [];
    for (let i = 0; i < barcodes.length; i++) {
        // TO DO: Substitute bitgener with library that supports label formatting with spaces 'sxcxc xvcxcv vvcxvs'
        const result = await bitgener({
            data: barcodes[i],
            type: 'code128',
            output: 'buffer',
            encoding: 'utf8',
            original1DSize: true,
            addQuietZone: true,
            color: '#000',
            bgColor: '#FFF',
            hri: {
                show: true,
                fontFamily: 'Futura',
                marginTop: 5,
            },
        });

        svgs.push(result.svg);
    }
    return svgs;
};
const convertImage = async (image) => {
    return sharp(image)
        .png({quality: 100})  // TO DO: lookup defaults
        .toBuffer({resolveWithObject: true});
};
const toPdf = async (svgs) => {
    let doc = null;

    for (let i = 0; i < svgs.length; i++) {
        if (i === 0) {
            doc = new pdfkit({size: 'A3'});
        } else {
            doc.addPage({size: 'A3'});
        }

        const {data, info} = await convertImage(svgs[i]);

        //                        center image             give bottom margin with 30 padding
        doc.image(data, (doc.page.width - info.width) / 2, doc.page.height - info.height - 30);
    }
    return doc;
};

router.get('/', (req, res, next) => {
    //test
    generateBarcodes(5)
        .then(barcodes => {
            return createBarcodeSVGs(barcodes);
        })
        .then(barcodeSVGs => {
            return toPdf(barcodeSVGs);
        })
        .then(pdf => {
            pdf.pipe(res);
            pdf.end();
        })
        .catch(err => {
            if (ERR(err, next)) return;
        });
});

router.post('/', function(req, res, next) {
    // stub for post to start barcode creation
});

module.exports = router;