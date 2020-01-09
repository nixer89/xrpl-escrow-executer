import * as scheduler from 'node-schedule';
import { RippleAPI } from 'ripple-lib';
import { EscrowExecution } from 'ripple-lib/dist/npm/transaction/escrow-execution';
import * as testEscrows  from './testEscrows';
import * as rippleEscrows  from './rippleEscrows';
import { Prepare } from 'ripple-lib/dist/npm/transaction/types';
import { FormattedSubmitResponse } from 'ripple-lib/dist/npm/transaction/submit';
require('console-stamp')(console, { pattern: 'yyyy-mm-dd HH:MM:ss' });

const server = process.env.XRPL_SERVER || 'wss://s.altnet.rippletest.net';
const xrpl_address = process.env.XRPL_ADDRESS || 'rpzR63sAd7fc4tR9c8k6MR3xhcZSpTAYKm';
const xrpl_secret = process.env.XRPL_SECRET || 'sskorjvv5bPtydsm5HtU1f2YxxA6D';

const api:RippleAPI = new RippleAPI({server: server});
initEscrowExecuter();

async function initEscrowExecuter() {
    let allEscrows:any[] = rippleEscrows.escrows;
    allEscrows.forEach(escrow => {
        let executionDate:Date = new Date(escrow.executeAfter);
        executionDate.setSeconds(executionDate.getSeconds()+1);

        let scheduleDate:Date = new Date(escrow.executeAfter);
        scheduleDate.setMinutes(scheduleDate.getMinutes()-1);
        //only schedule future escrows!
        if(Date.now() < scheduleDate.getTime()) {
            console.log("schedule escrow execution for: " + executionDate + " on accounts: " + JSON.stringify(escrow.escrowList));
            scheduler.scheduleJob(scheduleDate, () => preparingEscrowFinishTrx(executionDate, escrow.escrowList) );
        }
    });
}

async function preparingEscrowFinishTrx(executionDate:Date, escrowList:any[], retry?: boolean) {
    let preparedEscrowFinishTrx: Prepare[] = [];

    console.log("preparing escrows: " + JSON.stringify(escrowList));
    console.log("execution date: " + executionDate);

    await api.connect();
    let accountSequence = (await api.getAccountInfo(xrpl_address)).sequence;

    console.log("Account sequence: " + accountSequence);
    
    for(let i = 0; i < escrowList.length; i++) {
        let escrowFinish:EscrowExecution = {
            owner: escrowList[i].account,
            escrowSequence: escrowList[i].sequence
        }

        console.log("preparing escrow with account sequence: " + accountSequence);
        preparedEscrowFinishTrx.push(await api.prepareEscrowExecution(xrpl_address, escrowFinish, {sequence: accountSequence, maxLedgerVersionOffset: 100 }));
        accountSequence++;

    }

    console.log("finished preparing escrows: " + JSON.stringify(escrowList));

    signingPreparedEscrowFinishTrx(executionDate, preparedEscrowFinishTrx, (retry?null:escrowList));
}

async function signingPreparedEscrowFinishTrx(executionDate:Date, preparedEscrowFinishTrx:Prepare[], escrowList:any[]) {
    let signedEscrowFinishTrx: any[] = [];

    console.log("signing escrows");
    for(let i = 0; i < preparedEscrowFinishTrx.length; i++) {
        signedEscrowFinishTrx.push(await api.sign(preparedEscrowFinishTrx[i].txJSON, xrpl_secret));
    }
    console.log("finished signing escrows");
    submitSignedEscrowFinishTrx(executionDate, signedEscrowFinishTrx,escrowList);
}

async function submitSignedEscrowFinishTrx(executionDate:Date, signedEscrowFinishTrx:any[], escrowList:any[]) {
    try {
        console.log("setting scheduler to submit transaction");
        scheduler.scheduleJob(executionDate, async () => {
            let trxHashes:string[] = [];
            let possibleUnsuccessfullEscrows:any[] = [];
            for(let i = 0; i < signedEscrowFinishTrx.length; i++) {
                console.log("submitting escrowFinish transaction")
                let result:FormattedSubmitResponse = await api.submit(signedEscrowFinishTrx[i].signedTransaction);
                if((!result || "tesSUCCESS" != result.resultCode) && (escrowList && escrowList[i])) {
                    trxHashes.push(result['tx_json'].hash);
                    possibleUnsuccessfullEscrows.push(escrowList[i]);
                }
            }

            setTimeout(async () => {
                let unsuccessfullEscrowTrx:any[] = [];
                if(trxHashes.length > 0) {
                    console.log("checking transactions: " + JSON.stringify(trxHashes));
                    for(let i = 0; i < trxHashes.length; i++) {
                        try {
                        let trx = await api.getTransaction(trxHashes[i], {includeRawTransaction: false});
                        console.log("final restult: " + JSON.stringify(trx.outcome));
                        if((!trx || (trx.outcome && "tesSUCCESS" != trx.outcome.result && "tecNO_TARGET" != trx.outcome.result)) && (possibleUnsuccessfullEscrows && possibleUnsuccessfullEscrows[i]))
                            unsuccessfullEscrowTrx.push(possibleUnsuccessfullEscrows[i]);
                        } catch(err) {
                            console.log("ups, something went wrong with trx: " + trxHashes[i]);
                        }
                    }
                } else {
                    console.log("everything submitted successfully");
                }

                if(api.isConnected())
                    await api.disconnect();

                //check for not executed escrows
                if(unsuccessfullEscrowTrx && unsuccessfullEscrowTrx.length > 0) {
                    let newExecutionDate = new Date(executionDate);
                    newExecutionDate.setSeconds(newExecutionDate.getSeconds()+20);

                    setTimeout(() => preparingEscrowFinishTrx(newExecutionDate, unsuccessfullEscrowTrx, true), 1000);
                }
            }, 4000)
        });

    } catch(err) {
        console.log(JSON.stringify(err));
    }
}
