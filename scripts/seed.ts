import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
async function main(){const {getStore}=await import('../lib/storage');const store=await getStore();const counts=await Promise.all(['profiles','sales_orders','inventory_snapshots','mock_badges'].map(async table=>({table,count:(await store.list(table as 'profiles'|'sales_orders'|'inventory_snapshots'|'mock_badges')).length})));console.log(JSON.stringify({adapter:store.adapter,counts},null,2));store.close?.();}
main().catch(()=>{console.error('Seed failed; check storage configuration and applied migration. No credentials printed.');process.exitCode=1;});
