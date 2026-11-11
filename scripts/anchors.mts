/** pnpm anchors verify <tenant> : check the anchor files in ANCHOR_DIR against the live database (DATABASE_URL, the app role). Exit 1 on any problem. */
import { FileAnchorSink, verifyAnchors } from '../src/ops/anchor';
import { PgRepo } from '../src/api/pg-repo';
const [cmd, tenant] = process.argv.slice(2);
if (cmd !== 'verify' || !tenant || !process.env['ANCHOR_DIR'] || !process.env['DATABASE_URL']) { console.error('Usage: ANCHOR_DIR=… DATABASE_URL=… pnpm anchors verify <tenant>'); process.exit(2); }
const repo = await PgRepo.connect(process.env['DATABASE_URL']);
const problems = await verifyAnchors(repo, new FileAnchorSink(process.env['ANCHOR_DIR']), tenant);
await repo.close();
if (problems.length) { console.error(JSON.stringify(problems, null, 2)); process.exit(1); }
console.log(`OK: ${tenant} agrees with every anchor.`);
