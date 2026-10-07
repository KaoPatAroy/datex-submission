import {withReadSnapshot} from '@/lib/storage/read-snapshot';
import {NextResponse} from 'next/server';import {getStore} from '@/lib/storage';import {actorSession} from '@/lib/server/session';import {failure} from '@/lib/server/http';import {ConciergeService} from '@/lib/core/service';
export const runtime='nodejs';
export async function GET(){try{const store=await getStore();return await withReadSnapshot(store,async()=>{const {actor,session}=await actorSession(store);const workspace=await new ConciergeService(store).getWorkspace(actor);return NextResponse.json({...workspace,csrfToken:session.csrfToken},{headers:{'Cache-Control':'no-store'}});});}catch(error){return failure(error);}}
