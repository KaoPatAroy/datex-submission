import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { DomainError } from '../core/errors';
import { AIRuntimeError } from '../ai/errors';
import { safeWorkflowErrorSchema, type SafeWorkflowError } from '../workflows/contracts';

const workflowFailureFields = [
  'code', 'outcome', 'message', 'correlationId', 'actionId', 'executionId',
  'commitCertainty', 'domainEffect', 'operationPhase', 'auditStatus', 'nextStep',
  'retryBusinessWrite', 'reasons', 'currentStates'
] as const;

// Only bounded machine identifiers belong in diagnostics; these never inspect user language.
const diagnosticName = /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/;
const diagnosticCode = /^[A-Z0-9_]{1,64}$/;

function workflowFailureDetails(error: unknown): SafeWorkflowError | undefined {
  if (!(error instanceof DomainError) || error.name !== 'WorkflowOperationError') return undefined;

  try {
    const prototype = Object.getPrototypeOf(error);
    const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    if (typeof constructor !== 'function' || constructor.name !== 'WorkflowOperationError') return undefined;

    const detailsProperty = Object.getOwnPropertyDescriptor(error, 'details');
    if (!detailsProperty || !('value' in detailsProperty) || !detailsProperty.enumerable) return undefined;
    const details = detailsProperty.value;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;

    const candidate: Record<string, unknown> = {};
    for (const field of workflowFailureFields) {
      const property = Object.getOwnPropertyDescriptor(details, field);
      if (!property && field === 'operationPhase') continue;
      if (!property || !('value' in property)) return undefined;
      candidate[field] = property.value;
    }

    const parsed = safeWorkflowErrorSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.code !== error.code || parsed.data.message !== error.message) return undefined;

    const expectedStatus = parsed.data.outcome === 'denied' ? 403 : parsed.data.outcome === 'stale' ? 409 : 503;
    return error.status === expectedStatus ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function failure(error:unknown):NextResponse {
  if(error instanceof ZodError)return NextResponse.json({error:{code:'INVALID_INPUT',message:'รูปแบบข้อมูลไม่ถูกต้อง'}},{status:400});
  const workflowDetails = workflowFailureDetails(error);
  if (workflowDetails) {
    const status = workflowDetails.outcome === 'denied' ? 403 : workflowDetails.outcome === 'stale' ? 409 : 503;
    return NextResponse.json({ error: workflowDetails }, { status });
  }
  if (error instanceof DomainError && error.code === 'TRANSPORT_OUTCOME_UNKNOWN') {
    return NextResponse.json({error:{code:'TRANSPORT_OUTCOME_UNKNOWN',message:'ยังไม่ทราบผลการดำเนินการ กรุณาตรวจสถานะคำขอเดิมก่อนลองอีกครั้ง'}},{status:503});
  }
  if(error instanceof DomainError && error.name !== 'WorkflowOperationError')return NextResponse.json({error:{code:error.code,message:error.message}},{status:error.status,headers:error.status===429?{'Retry-After':'300'}:{}});
  if(error instanceof AIRuntimeError&&((error.code==='FORBIDDEN'&&error.status===403)||(error.code==='UNAUTHENTICATED'&&error.status===401)))return NextResponse.json({error:{code:error.code,message:error.status===403?'บัญชีนี้ไม่มีสิทธิ์ดำเนินการนี้':'กรุณาเข้าสู่ระบบใหม่'}},{status:error.status});
  if(error&&typeof error==='object'&&'code'in error&&error.code==='CONFLICT')return NextResponse.json({error:{code:'CONFLICT',message:'ข้อมูลมีการเปลี่ยนพร้อมกัน กรุณาตรวจสถานะก่อนลองใหม่'}},{status:409});
  // Metadata only: never pass the error itself, its message, stack or attached payload to the logger.
  let metadata: { class: string; name: string | null; code: string | number | null } = { class: typeof error, name: null, code: null };
  try {
    if (error && typeof error === 'object') {
      const prototype = Object.getPrototypeOf(error);
      const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
      let name = Object.getOwnPropertyDescriptor(error, 'name');
      for (let ancestor = prototype; ancestor && !name; ancestor = Object.getPrototypeOf(ancestor)) {
        name = Object.getOwnPropertyDescriptor(ancestor, 'name');
      }
      const code = Object.getOwnPropertyDescriptor(error, 'code');
      const codeValue = code && 'value' in code ? code.value : undefined;
      metadata = {
        class: typeof constructor === 'function' && diagnosticName.test(constructor.name) ? constructor.name : 'Object',
        name: name && 'value' in name && typeof name.value === 'string' && diagnosticName.test(name.value) ? name.value : null,
        code: typeof codeValue === 'string' && diagnosticCode.test(codeValue) ? codeValue
          : typeof codeValue === 'number' && Number.isSafeInteger(codeValue) && Math.abs(codeValue) <= 999999 ? codeValue : null,
      };
    }
  } catch { /* A hostile thrown object must not break the safe failure response. */ }
  console.error(metadata);
  return NextResponse.json({error:{code:'UNAVAILABLE',message:'ระบบยังไม่พร้อมใช้งาน กรุณาตรวจสถานะคำขอเดิมก่อนลองอีกครั้ง หากต้องการดูตัวอย่างการทำงาน คุณสามารถใช้โหมดสาธิตได้'}},{status:503});
}
