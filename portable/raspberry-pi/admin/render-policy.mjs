import { generatePolicy } from '../network/generate-policy.mjs';
const [torUid, dhcpUid] = process.argv.slice(2).map(Number);
process.stdout.write(generatePolicy({ torUid, dhcpUid, lanAdmin: true }).nftables);
