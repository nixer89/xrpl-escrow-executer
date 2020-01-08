import * as scheduler from 'node-schedule';
import { RippleAPI } from 'ripple-lib';
import { EscrowExecution } from 'ripple-lib/dist/npm/transaction/escrow-execution';
import * as escrowInfos  from './escrowList';
import { Prepare } from 'ripple-lib/dist/npm/transaction/types';
import { FormattedSubmitResponse } from 'ripple-lib/dist/npm/transaction/submit';
require('console-stamp')(console, { pattern: 'yyyy-mm-dd HH:MM:ss' });

const server = process.env.XRPL_SERVER || 'wss://s.altnet.rippletest.net';
const xrpl_address = process.env.XRPL_ADDRESS || 'rpzR63sAd7fc4tR9c8k6MR3xhcZSpTAYKm';
const xrpl_secret = process.env.XRPL_SECRET || 'sskorjvv5bPtydsm5HtU1f2YxxA6D';

const api:RippleAPI = new RippleAPI({server: server, proxy: "http://proxy:81"});
initEscrowExecuter();

async function initEscrowExecuter() {
    let allEscrows:any[] = escrowInfos.escrows;
    allEscrows.forEach(escrow => {
        let executionDate:Date = new Date(escrow.executeAfter);
        executionDate.setSeconds(executionDate.getSeconds()-1);

        let scheduleDate:Date = new Date(escrow.executeAfter);
        scheduleDate.setMinutes(scheduleDate.getMinutes()-1);
        //only schedule future escrows!
        if(Date.now() < scheduleDate.getTime()) {
            console.log("schedule escrow execution for: " + scheduleDate + " on accounts: " + JSON.stringify(escrow.escrowList));
            scheduler.scheduleJob(scheduleDate, () => preparingEscrowFinishTrx(executionDate, escrow.escrowList) );
        }
    });
}

async function preparingEscrowFinishTrx(executionDate:Date, escrowList:any[]) {
    let preparedEscrowFinishTrx: Prepare[] = [];

    console.log("preparing escrows: " + JSON.stringify(escrowList));
    console.log("execution date: " + executionDate);

    await api.connect();
    let accountSequence = (await api.getAccountInfo(xrpl_address)).sequence;
    
    for(let i = 0; i < escrowList.length; i++) {
        let escrowFinish:EscrowExecution = {
            owner: escrowList[i].account,
            escrowSequence: escrowList[i].sequence
        }

        preparedEscrowFinishTrx.push(await api.prepareEscrowExecution(xrpl_address, escrowFinish, {sequence: accountSequence++, maxLedgerVersionOffset: 100 }));
    }

    console.log("finished preparing escrows: " + JSON.stringify(escrowList));

    signingPreparedEscrowFinishTrx(executionDate, preparedEscrowFinishTrx);
}

async function signingPreparedEscrowFinishTrx(executionDate:Date, preparedEscrowFinishTrx:Prepare[]) {
    let signedEscrowFinishTrx: any[] = [];

    console.log("signing escrows");
    for(let i = 0; i < preparedEscrowFinishTrx.length; i++) {
        signedEscrowFinishTrx.push(await api.sign(preparedEscrowFinishTrx[i].txJSON, xrpl_secret));
    }
    console.log("finished signing escrows");
    submitSignedEscrowFinishTrx(executionDate, signedEscrowFinishTrx);
}

async function submitSignedEscrowFinishTrx(executionDate:Date, signedEscrowFinishTrx:any[]) {
    try {
        console.log("setting scheduler to submit transaction");
        scheduler.scheduleJob(executionDate, async () => {
            let unsuccessfullTrx:any[] = [];
            for(let i = 0; i < signedEscrowFinishTrx.length; i++) {
                console.log("submitting escrowFinish transaction")
                let result:FormattedSubmitResponse = await api.submit(signedEscrowFinishTrx[i].signedTransaction);
                console.log(JSON.stringify(result));

                if(!result || "tesSUCCESS" != result.resultCode)
                    unsuccessfullTrx.push(signedEscrowFinishTrx[i]);
            }

            if(api.isConnected())
                await api.disconnect();

            if(unsuccessfullTrx && unsuccessfullTrx.length > 0) {
                let newExecutionDate = new Date(executionDate);
                newExecutionDate.setSeconds(newExecutionDate.getSeconds()+10);

                submitSignedEscrowFinishTrx(newExecutionDate, unsuccessfullTrx);
            }
        });

    } catch(err) {
        console.log(JSON.stringify(err));
    }
}
