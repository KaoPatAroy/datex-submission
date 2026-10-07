import {withReadSnapshot} from '@/lib/storage/read-snapshot';
import { NextRequest,NextResponse } from 'next/server';
import {z} from 'zod';
import {getStore} from '@/lib/storage';
import {actorSession,changeMode,checkCsrf,login,logout,rateLimit,sameOrigin,trustedClientIp} from '@/lib/server/session';
import {failure} from '@/lib/server/http';
export const runtime='nodejs';
export async function GET(){try{const store=await getStore();return await withReadSnapshot(store,async()=>{const {actor,session}=await actorSession(store);return NextResponse.json({actor,csrfToken:session.csrfToken,businessDate:process.env.DEMO_BUSINESS_DATE??'2026-10-01',storage:store.adapter},{headers:{'Cache-Control':'no-store'}});});}catch(error){return failure(error);}}
export async function POST(request:NextRequest){try{sameOrigin(request);const store=await getStore();await rateLimit(store,'login:'+trustedClientIp(request),Number(process.env.DEMO_LOGIN_REQUEST_LIMIT??20));const body=z.object({profileId:z.enum(['executive','east','hr','director']),accessCode:z.string().max(200)}).strict().parse(await request.json());await login(store,body.profileId,body.accessCode);return GET();}catch(error){return failure(error);}}
export async function DELETE(request:NextRequest){try{const store=await getStore();const {session}=await actorSession(store);checkCsrf(request,session);await logout(store,session);return NextResponse.json({ok:true});}catch(error){return failure(error);}}
export async function PATCH(request:NextRequest){try{const store=await getStore();const {session}=await actorSession(store);checkCsrf(request,session);const body=z.object({mode:z.enum(['live_ai','scripted_demo'])}).strict().parse(await request.json());await changeMode(store,session,body.mode);return GET();}catch(error){return failure(error);}}
