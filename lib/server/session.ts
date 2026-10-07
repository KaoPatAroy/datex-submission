import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {isIP} from 'node:net';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import type { Actor, Mode, Store } from '../contracts';
import { readCurrentProfile, type SessionRow } from '../core/auth';
import { DomainError, invariant } from '../core/errors';
import { digest, id } from '../core/utils';

const cookieName='biztania_session';
function secret():string {const value=process.env.DEMO_SESSION_SECRET;invariant(value&&value.length>=32,'CONFIGURATION','ยังไม่พร้อมให้เข้าสู่ระบบ กรุณาติดต่อผู้ดูแล',503);return value;}
const sign=(value:string)=>createHmac('sha256',secret()).update(value).digest('hex');
function equal(a:string,b:string):boolean {const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}
function signedCookieSessionId(raw:string|undefined):string|undefined {if(!raw)return undefined;const [sessionId,signature,...rest]=raw.split('.');return sessionId&&signature&&!rest.length&&equal(signature,sign(sessionId))?sessionId:undefined;}
export async function actorSession(store:Store):Promise<{actor:Actor;session:SessionRow}> {
  const raw=(await cookies()).get(cookieName)?.value;invariant(raw,'UNAUTHENTICATED','กรุณาเข้าสู่ระบบ',401);const [sessionId,signature,...rest]=raw.split('.');invariant(!rest.length&&signature&&equal(signature,sign(sessionId)),'UNAUTHENTICATED','การเข้าสู่ระบบนี้ใช้ต่อไม่ได้ กรุณาเข้าสู่ระบบใหม่',401);
  const session=await store.get<SessionRow>('sessions',sessionId),profile=session?await readCurrentProfile(store,session.profileId):undefined;
  invariant(session&&profile?.active&&new Date(session.expiresAt)>new Date(),'UNAUTHENTICATED','การเข้าสู่ระบบนี้ใช้ต่อไม่ได้ กรุณาเข้าสู่ระบบใหม่',401);return {actor:{...profile,sessionId:session.id,mode:session.mode,modeRevision:session.modeRevision},session};
}
export function sameOrigin(request:NextRequest) {
  // NextURL normalizes loopback hosts to localhost; retain the actual HTTP authority.
  const authority=request.headers.get('host')??request.nextUrl.host;
  const expected=`${request.nextUrl.protocol}//${authority}`;
  invariant(request.headers.get('origin')===expected,'CSRF','ตรวจสอบคำขอนี้ไม่ได้ กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง',403);
}
export function checkCsrf(request:NextRequest,session:SessionRow) {sameOrigin(request);invariant(equal(request.headers.get('x-csrf-token')??'',session.csrfToken),'CSRF','ตรวจสอบคำขอนี้ไม่ได้ กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง',403);}
export async function login(store:Store,profileId:string,accessCode:string):Promise<void> {
  const expected=process.env.DEMO_ACCESS_CODE;invariant(expected&&expected.length>=8,'CONFIGURATION','ยังไม่พร้อมให้เข้าสู่ระบบ กรุณาติดต่อผู้ดูแล',503);invariant(equal(digest(accessCode),digest(expected)),'UNAUTHENTICATED','รหัสเข้าใช้งานไม่ถูกต้อง กรุณาตรวจรหัสแล้วลองอีกครั้ง',401);
  const profile=await readCurrentProfile(store,profileId);invariant(profile?.active,'UNAUTHENTICATED','โปรไฟล์นี้ยังเข้าใช้งานไม่ได้ กรุณาเลือกโปรไฟล์อื่นหรือติดต่อผู้ดูแล',401);
  const jar=await cookies(), previous=signedCookieSessionId(jar.get(cookieName)?.value);
  const row:SessionRow={id:id('session'),profileId,mode:'live_ai',modeRevision:0,csrfToken:randomBytes(24).toString('hex'),expiresAt:new Date(Date.now()+8*60*60_000).toISOString()};
  const cookieValue=`${row.id}.${sign(row.id)}`;
  await store.transaction(async tx=>{if(previous){const old=await tx.get<SessionRow>('sessions',previous);if(old)await tx.put('sessions',{...old,expiresAt:new Date(0).toISOString()});}await tx.put('sessions',row);});
  jar.set(cookieName,cookieValue,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:8*60*60});
}
export async function logout(store:Store,session:SessionRow):Promise<void> {await store.transaction(async tx=>{const latest=await tx.get<SessionRow>('sessions',session.id);invariant(latest&&latest.profileId===session.profileId,'UNAUTHENTICATED','การเข้าสู่ระบบนี้ใช้ต่อไม่ได้ กรุณาเข้าสู่ระบบใหม่',401);await tx.put('sessions',{...latest,expiresAt:new Date(0).toISOString()});});(await cookies()).delete(cookieName);}
export async function changeMode(store:Store,session:SessionRow,mode:Mode):Promise<void> {
  // Router-staged proposals belong to the mode they were made in: a mode change stales them too (hosted stores may lack the table).
  let stagedTable=true;try{await store.list('router_proposals',{actorId:'__probe__'});}catch{stagedTable=false;}
  await store.transaction(async tx=>{const latest=await tx.get<SessionRow>('sessions',session.id);invariant(latest,'UNAUTHENTICATED','การเข้าสู่ระบบนี้ใช้ต่อไม่ได้ กรุณาเข้าสู่ระบบใหม่',401);await tx.put('sessions',{...latest,mode,modeRevision:latest.modeRevision+1});for(const action of await tx.list<{id:string;sessionId:string;status:string;contractVersion?:number}>('pending_actions'))if(action.sessionId===session.id&&action.status==='pending'&&action.contractVersion!==2)await tx.put('pending_actions',{...action,status:'stale'});
    if(stagedTable)for(const row of await tx.list<{id:string;actorId:string;sessionId?:string;status:string;revision:number}>('router_proposals',{actorId:latest.profileId}))if(row.actorId===latest.profileId&&row.sessionId===session.id&&(row.status==='pending'||row.status==='claimed'))await tx.put('router_proposals',{...row,status:'stale',claimToken:undefined,claimExpiresAt:undefined,updatedAt:Date.now(),revision:row.revision+1});});
}
export async function rateLimit(store:Store,key:string,max:number):Promise<void> {
  invariant(Number.isInteger(max)&&Number.isFinite(max)&&max>0&&max<=10000,'CONFIGURATION','ระบบยังไม่พร้อมรับคำขอ กรุณาติดต่อผู้ดูแล',503);
  const bucket=Math.floor(Date.now()/300_000),counterId=digest(`${key}:${bucket}`);
  await store.transaction(async tx=>{for(const old of await tx.list<{id:string;bucket:number}>('rate_limits'))if(old.bucket<bucket-1)await tx.remove('rate_limits',old.id);const row=await tx.get<{id:string;count:number}>('rate_limits',counterId);if((row?.count??0)>=max)throw new DomainError('RATE_LIMIT','คำขอเกินขีดจำกัด โปรดลองอีกครั้งในภายหลัง',429);await tx.put('rate_limits',{id:counterId,count:(row?.count??0)+1,bucket});});
}
/** Vercel overwrites X-Forwarded-For at its ingress. Other deployments ignore caller headers. */
export function trustedClientIp(request:NextRequest):string {
  if(process.env.VERCEL!=='1')return 'local-or-untrusted-proxy';
  const value=request.headers.get('x-forwarded-for')?.trim()??'';
  return isIP(value)?value:'unknown-vercel-client';
}
