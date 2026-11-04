import {writeFileSync} from 'node:fs';
writeFileSync(process.env.ASSERTLEDGER_QUALIFICATION_RESULT_FILE, JSON.stringify({facts:{commandOutcome:'EXPECTED_FAILURE',exitCode:7},nonce:process.env.ASSERTLEDGER_QUALIFICATION_NONCE,protocolVersion:'1.0.0'})+'\n');
process.exit(7);
