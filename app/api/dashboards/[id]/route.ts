import {withReadSnapshot} from '@/lib/storage/read-snapshot';
import {NextRequest,NextResponse} from 'next/server';import {z} from 'zod';import {getStore} from '@/lib/storage';import {actorSession,checkCsrf,rateLimit,trustedClientIp} from '@/lib/server/session';import {failure} from '@/lib/server/http';import {ConciergeService} from '@/lib/core/service';
export const runtime='nodejs';
const renameSchema=z.object({title:z.string().trim().min(1).max(120),description:z.string().trim().max(500).optional(),baseRevision:z.string().min(1).max(200)}).strict();
export async function GET(_request:Request,context:{params:Promise<{id:string}>}){try{const store=await getStore();return await withReadSnapshot(store,async()=>{const {actor}=await actorSession(store);const{id}=await context.params;return NextResponse.json(await new ConciergeService(store).dashboard(actor,id),{headers:{'Cache-Control':'no-store'}});});}catch(error){return failure(error);}}
/** Rename or re-describe the owner's own dashboard. Private and reversible => direct; a shared Dashboard stages the confirm proposal. */
export async function PATCH(request:NextRequest,context:{params:Promise<{id:string}>}){try{
  const store=await getStore(),{actor,session}=await actorSession(store);checkCsrf(request,session);
  await rateLimit(store,`dashboards:session:${session.id}`,Number(process.env.DEMO_SESSION_REQUEST_LIMIT??20));await rateLimit(store,`dashboards:ip:${trustedClientIp(request)}`,Number(process.env.DEMO_IP_REQUEST_LIMIT??60));
  const{id}=await context.params,{baseRevision,...body}=renameSchema.parse(await request.json());
  // CAS on the revision the client loaded: a stale PATCH (the dashboard changed meanwhile) is a 409 DASHBOARD_CHANGED, never an overwrite.
  // Private: applied directly (the view). Shared: the SAME staged confirm proposal chat creates ({outcome:'staged'}); never a silent write.
  const result=await new ConciergeService(store).editDashboardUi(actor,id,{kind:'rename',...body,baseRevision});
  return NextResponse.json(result.outcome==='updated'?result.view:result,{headers:{'Cache-Control':'no-store'}});
}catch(error){return failure(error);}}
