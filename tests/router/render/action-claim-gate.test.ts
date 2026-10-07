import { describe, expect, it } from 'vitest';
import { hasActionClaim, isSafeClarificationText, isSafeConversationTitle, isSafeFollowUp, MODEL_TEXT_SURFACES, modelTextSafe, type ModelTextSurface } from '@/lib/router/render/safety';

/** The conversation-prose action-claim gate (MODEL output only): blocks effect claims, keeps descriptive / advisory prose. */
describe('hasActionClaim (conversation prose gate)', () => {
  it.each([
    'ผมสร้าง Dashboard ให้แล้ว', 'สร้าง Dashboard ให้เรียบร้อยแล้วครับ', 'ผมส่งข้อความถึงผู้จัดการแล้ว', 'Monitor ถูกหยุดชั่วคราวแล้ว',
    'ลบ Dashboard นั้นเรียบร้อยแล้ว', 'ผมได้ยกเลิกรายการนั้นให้แล้ว', 'เปลี่ยนชื่อ Dashboard เป็นยอดขายตะวันออกสำเร็จแล้ว', 'ระบบจะส่ง Email ให้ทันที',
    'ผมเปลี่ยนชื่อ Dashboard ให้คุณ', 'ฉันลบ Monitor นั้นให้', 'ส่งข้อความให้ผู้จัดการภาคตะวันออกเรียบร้อยแล้ว', 'คำขอได้รับอนุมัติเรียบร้อยแล้ว',
    'I have deleted the dashboard.',
    // FW-B: bare / passive English completion claims
    'Your changes are saved.', 'Changes saved.', 'Done.', 'All set, the monitor is paused now', 'The dashboard was deleted.', 'Message sent!',
    'I saved your changes', 'Your request has been submitted', 'The task is now completed', 'It is done',
  ])('blocks the effect claim %s', prose => expect(hasActionClaim(prose)).toBe(true));

  it.each([
    'หลังจากบันทึก Result เรียบร้อยแล้ว คุณสามารถเพิ่มลง Dashboard ได้',
    'ถ้าสร้าง Monitor สำเร็จแล้ว ระบบจะตรวจตามรอบรายวัน',
    'Action จะเปลี่ยนข้อมูลก็ต่อเมื่อคุณยืนยันและระบบตรวจผลสำเร็จแล้วเท่านั้น',
    'ผลการดำเนินการจะแสดงหลังระบบตรวจสอบเรียบร้อยแล้ว',
    'ก่อนส่ง Email จำลอง ระบบจะให้คุณตรวจรายละเอียดจนเรียบร้อยแล้วจึงยืนยัน',
    // FW-B: English descriptive / conditional / advisory prose still passes
    'Changes are saved only after you confirm the preview.', 'When a result is saved, it stays a snapshot.', 'You can save the result and add it to a dashboard later.',
    'Once the request is approved, the next step is an email.', 'A monitor should be paused before you edit it.',
    'Dashboards re-query permitted data whenever they are opened.',
  ])('keeps the descriptive / advisory prose %s', prose => expect(hasActionClaim(prose)).toBe(false));

  // G2: a conditional / future / descriptive marker exempts only ITS OWN clause, never a completion claim in a sibling clause.
  it.each([
    'Your changes are saved, and you can check History.', 'Your changes are saved and you can check History.',
    'You can check History; your changes are saved.', 'If you want, the dashboard was deleted.', 'Changes saved, and you can open History anytime.',
    'The monitor is paused now, but you can resume it later.', 'Everything is updated so you can review it whenever you like.',
    'Your request has been submitted and will appear in History.', 'Saved, you can now check History.', 'I saved your changes, then you can share them.',
    'I can help you create a dashboard if you like.', 'I can explain the options and send you the report.', 'I can summarize it, then share it with your team.', 'I can explain the options and will send you the report.', "I'll explain the steps and then I'll share the dashboard.", 'Let me summarize this, plus send it to the team.', 'I can take a look at that.', 'I can get back to you on this.', 'We can follow up tomorrow.', 'If you want, I can put together a dashboard.', 'If you confirm, I can prepare it as a proposal.', 'I can check that.', 'We can look into it right away.', 'I can pause the monitor now.', "I've saved your changes.", 'I did it.', 'We did that for you.', 'I sorted it out.', 'We’ve sent the report to your team.', "I'd already created the dashboard.", 'Saved your changes to the dashboard.',
    'Sent it to the team just now.', "I've archived the old dashboard, and you can restore it anytime.",
    'บันทึกการเปลี่ยนแปลงเรียบร้อยแล้ว และคุณสามารถดูได้ที่ History', 'หากต้องการ คุณดู History ได้ และ Dashboard ถูกลบแล้ว',
    'คุณสามารถเปิดดูได้ภายหลัง แต่ผมส่งข้อความถึงผู้จัดการแล้ว', 'เมื่อพร้อมแล้ว จากนั้นผมยกเลิกรายการนั้นให้แล้ว',
  ])('blocks a completion claim beside an exempt clause %s', prose => expect(hasActionClaim(prose)).toBe(true));

  it.each([
    'When a result is saved, it stays a snapshot and you can add it to a dashboard.', 'Once the dashboard is created and shared, your team can open it.',
    'Dashboards can be created, shared and deleted from the Dashboards page.', 'If the request is approved and the email is sent, History records a receipt.',
    'Changes are saved only after you confirm, and History keeps the receipt.', 'You can save a result, and later you can share it.',
    'หลังจากบันทึก Result เรียบร้อยแล้ว และตรวจสอบแล้ว คุณสามารถเพิ่มลง Dashboard ได้', 'ถ้าสร้าง Monitor สำเร็จแล้ว จากนั้นระบบจะตรวจตามรอบรายวัน',
  ])('keeps clause-scoped descriptive prose %s', prose => expect(hasActionClaim(prose)).toBe(false));

  // G4: fail closed on completion vocabulary (reviewer strings first, then adversarial variants).
  it.each([
    'Your dashboard is ready.', 'I went ahead and created your dashboard.', 'Great — saved your changes.',
    'เรียบร้อยครับ', 'ดำเนินการให้แล้ว', 'จัดการให้แล้ว',
    "Everything's ready to go", 'Okay, your monitor is all set.', 'Great news: the report went out and is in place.', 'Sure thing, taken care of!',
    'Your dashboard is live now.', 'Setup complete.', "I've set up the monitor for you.", 'Got it — finished updating the dashboard.',
    'Okay deleted the old widget.', 'Perfect, the ticket has been added to your queue.', 'No problem I have set up the alert.',
    'All good — everything is in place.', 'The share link is ready for your team.', 'Dashboard ready แล้วครับ',
    'เสร็จเรียบร้อยแล้วค่ะ', 'ได้ทำการบันทึกไว้ให้แล้ว', 'ระบบจัดการเรียบร้อย', 'เสร็จแล้วครับ', 'เรียบร้อยนะครับ',
    'ทุกอย่างเรียบร้อยแล้วครับ', 'ตั้ง Monitor ให้แล้วครับ', 'เตรียม Dashboard ไว้ให้แล้วค่ะ', 'ทำให้เรียบร้อยแล้วครับ',
    'Dashboard พร้อมใช้งานแล้วครับ', 'ดำเนินการสำเร็จ', 'รับทราบครับ จัดการเรียบร้อยแล้ว', 'เมื่อวานจัดการให้แล้วครับ',
  ])('G4 blocks the completion claim %s', prose => expect(hasActionClaim(prose)).toBe(true));

  it.each([
    'Result เป็น snapshot ของคำตอบที่ตรวจสอบแล้ว ส่วน Dashboard ดึงข้อมูลใหม่ทุกครั้งที่เปิดหรือรีโหลด',
    'Dashboard ดึงข้อมูลใหม่ทุกครั้งที่เปิด ไม่ได้อัปเดตแบบเรียลไทม์',
    'Dashboard เก็บนิยามคำค้น ขอบเขต และรูปแบบกราฟไว้ แล้วดึงข้อมูลตามสิทธิ์ปัจจุบันใหม่ทุกครั้งที่เปิดหรือรีโหลด',
    'รับทราบครับ ยังไม่ดำเนินการลบแดชบอร์ดใด ๆ', 'ยังไม่เสร็จครับ', 'กรุณาตรวจรายละเอียดให้เรียบร้อยก่อนยืนยัน',
    'Nothing is created yet.', "Your dashboard isn't ready yet.",
    'Dashboards can be created, shared, renamed and deleted from the Dashboards page.', 'Would you like me to prepare a dashboard?',
    'I can explain how Monitors work.',
  ])('G4 keeps the non-claim prose %s', prose => expect(hasActionClaim(prose)).toBe(false));

  // G5: natural completion phrasings that passed 703efe8 (reviewer list) and adversarial variants of the broadened rules.
  it.each([
    'I put together your dashboard.', 'I made the requested changes.', 'Your dashboard is up and running.', 'จัดให้แล้วครับ', 'Dashboard ใช้งานได้แล้วครับ',
    'จัดให้แล้วครับ ต้องการอะไรเพิ่มเติม?', 'All set', "I've put together a dashboard for you.", 'We got it sorted.', 'I just took care of it.',
    'The monitor is good to go.', 'Your report is ready to use.', 'The dashboard is live.', 'Your alert is in place.', 'I fixed the chart.',
    'ทำให้แล้วนะครับ', 'Monitor พร้อมได้แล้ว', 'เปิดได้แล้วครับ', 'ใช้ได้แล้วครับ', 'ตั้งให้แล้ว ลองเปิดดูได้เลย',
  ])('G5 blocks the completion claim %s', prose => expect(hasActionClaim(prose)).toBe(true));

  it.each([
    'Incident ที่แก้ไขแล้วในช่วงเวลานี้', 'Dashboard ที่สร้างแล้วอยู่ในหน้า Dashboard', 'Dashboards show live data whenever they are opened.',
    'Once it is ready to use, you can share it.',
    'หากยืนยันแล้ว Dashboard จะใช้งานได้ทันที', 'ต้องการให้ส่งการแจ้งเตือนถึงใครครับ', 'ต้องการเก็บถาวร Dashboard ใดครับ',
  ])('G5 keeps the non-claim text %s', prose => expect(hasActionClaim(prose)).toBe(false));
  // G6: a subordinator / conditional / modal marker exempts ONLY the words after it up to the clause end; a claim that precedes it still blocks.
  it.each([
    'Your changes are saved if you want to check History.', 'The dashboard was deleted when you asked for it.', 'Your monitor is paused until you resume it.',
    'Message sent if you need anything else.', 'Your dashboard is ready whenever you want to open it.', 'Your report was sent before the deadline.',
    'Everything is all set in case you want to review it.', 'The ticket has been submitted unless you tell me otherwise.', 'Saved your changes, if you want to check them.',
    'Dashboard สร้างแล้ว ถ้าต้องการดูให้เปิดหน้า Dashboard', 'บันทึกเรียบร้อยแล้วหากต้องการดูให้เปิด History', 'ส่งข้อความแล้วเมื่อคุณขอ',
    'Dashboard ถูกลบแล้วถ้าต้องการกู้คืนให้ติดต่อผู้ดูแล', 'บันทึกการเปลี่ยนแปลงแล้วจะเห็นใน History', 'สร้าง Dashboard แล้วถ้าต้องการแก้ไขบอกได้',
  ])('G6 blocks a claim that precedes its trailing condition %s', prose => expect(hasActionClaim(prose)).toBe(true));

  it.each([
    'Changes are saved only after you confirm the preview.', 'A result is saved only when you confirm it.', 'You can check History once your changes are saved.',
    'Tell me if you want the dashboard updated.', 'Nothing is saved until you confirm.',
    'ถ้าต้องการดู Dashboard ที่สร้างแล้ว ให้เปิดหน้า Dashboard', 'หากบันทึกเรียบร้อยแล้ว คุณจะเห็นใน History', 'คุณจะเห็นใน History เมื่อบันทึกเรียบร้อยแล้ว',
  ])('G6 keeps the text whose marker governs the completion word %s', prose => expect(hasActionClaim(prose)).toBe(false));

  // P1 (final review): a future promise of action in conversation prose is false (no effect ran), Thai and English.
  it.each([
    'I’ll do it now', "I'll do it now.", 'Let me take care of that', "I'm going to pause it", 'I can do that now', 'I will handle it right away.',
    "We'll get it done today.", 'Sure, let me just delete the old widget.', 'I’ll go ahead and send the report.', "I'm gonna take care of it.",
    'Okay, I’ll take care of that for you.', 'You can relax; I will do that.',
    'เดี๋ยวจัดการให้ครับ', 'จะดำเนินการให้เลยครับ', 'เดี๋ยวผมจะหยุด Monitor ให้นะครับ', 'เดี๋ยวส่งให้ครับ', 'ขอดำเนินการให้ทันทีครับ', 'ได้ครับ จะจัดการให้เลย',
    'จะทำให้เลยครับ', 'ถ้าต้องการ เดี๋ยวสร้าง Dashboard ให้ครับ',
  ])('blocks the promise of action %s', prose => expect(hasActionClaim(prose)).toBe(true));

  it.each([
    'Let me explain how Monitors work.',
    'Would you like me to prepare a pause request?',
    'การตั้ง Monitor จะทำให้ระบบตรวจยอดขายทุกวัน', 'ระบบจะดำเนินการหลังจากคุณยืนยันเท่านั้น', 'เดี๋ยวนี้ Dashboard ดึงข้อมูลใหม่ทุกครั้งที่เปิด',
  ])('keeps the non-promise prose %s', prose => expect(hasActionClaim(prose)).toBe(false));

  // G7 (lead decision): EVERY first-person / assistant-voice commitment to future action blocks, whatever the verb, and a preceding
  // condition no longer exempts it (the two conditional promises at the end were G5 / P1 keep-controls). Reviewer strings first.
  it.each([
    'I’ll check that', 'จะส่งให้ครับ',
    "I'll check that for you.", 'I will look into it.', "I'll get the numbers for you.", 'Let me pull that up.', 'Let me check with the team.',
    "I'm going to review the queue.", "We'll follow up tomorrow.", 'We will contact the manager.', "I'll go ahead and draft it.",
    "Sure, I'll ping the East manager.", 'I can draft that for you.', 'I can look into it for you.', 'Okay — I’ll quickly refresh the dashboard.',
    "I'll explain the steps and then send the report.", "If you confirm, I'll send it.", 'Once you confirm I will notify the team.',
    'I am going to escalate this.', "I'll be happy to set that up.", "Got it. I'll follow up with the East team.",
    'เดี๋ยวตรวจสอบให้นะครับ', 'ขอจัดการให้เลย', 'ผมจะตรวจสอบให้ครับ', 'เดี๋ยวผมดูให้นะครับ', 'ได้ครับ จะเช็กให้เลย', 'รับทราบครับ จะแจ้งทีมให้',
    'ผมขอตรวจสอบข้อมูลก่อนนะครับ', 'เราจะติดตามเรื่องนี้ให้ครับ', 'ดิฉันจะประสานงานกับผู้จัดการให้ค่ะ', 'ฉันกำลังจะส่งรายงาน', 'เดี๋ยวเช็กให้ค่ะ',
    'จะรีบดำเนินการค่ะ', 'ตอนนี้จะส่งให้เลยครับ', 'รับทราบครับจะติดตามให้', 'ผมจะลองดูอีกครั้งนะครับ', 'เดี๋ยวค่อยส่งให้ครับ',
    'ถ้าคุณยืนยันจะจัดการให้ตามขั้นตอน', 'ถ้าต้องการ ผมจะจัดให้หลังจากคุณยืนยัน',
  ])('G7 blocks the commitment to future action %s', prose => expect(hasActionClaim(prose)).toBe(true));

  it.each([
    // Explanatory self-reference, negation and questions.
    'Shall I send it to the East manager?', 'Would you like me to prepare a draft?', 'Should I go ahead and create it?', 'Here is how sharing works.',
    "Here's what a Monitor does.", 'I can explain that for you.',
    'ผมขออธิบายสั้น ๆ นะครับ', 'ขออภัยครับ ข้อมูลนี้ไม่อยู่ในสิทธิ์ของบัญชี', 'ขอบคุณครับ', 'ขอให้ระบุภูมิภาคที่ต้องการครับ',
    'ต้องการให้ส่งรายงานไหมครับ', 'ต้องการให้ผมเตรียม Dashboard ไหมครับ',
    // Product semantics: a non-assistant subject before the future marker.
    'Dashboards refresh whenever you open them.', 'The system will ask you to confirm first.', 'You will see the change in History after you confirm.',
    'Dashboard จะดึงข้อมูลใหม่ทุกครั้งที่เปิด', 'ระบบจะขอให้คุณยืนยันก่อน', 'คุณจะเห็นผลใน History หลังยืนยัน', 'เมื่อเปิดหรือโหลดใหม่จะดึงข้อมูลที่ได้รับอนุญาต',
    'Monitor จะตรวจยอดขายทุกวันและแจ้งเตือนเมื่อต่ำกว่าเกณฑ์', 'การยืนยันจะทำให้ระบบสร้าง Ticket', 'ขอบเขตของบัญชีนี้ครอบคลุมยอดขายและสต็อก',
  ])('G7 keeps the explanation / question / product semantics %s', prose => expect(hasActionClaim(prose)).toBe(false));

  // G8 (lead decision): fail closed on assistant voice. ANY sentence whose subject is the assistant blocks, whatever the verb.
  // Reviewer strings first, then variants, then the former must-pass cases that are first person and not on the exact allowlist.
  it.each([
    'I can explain the options and carry out your request.', 'I’ll explain the steps and take action on it.', 'I performed the requested update.',
    'ผมจะอธิบายตัวเลือกและเปลี่ยนให้',
    "I'd be glad to look at it.", "We're on it.", "I've reviewed the queue.", 'I am working on it now.', "Let's get this started.",
    'I think the East region needs attention.', "I'll keep an eye on it.", "We've got this covered.", 'I can explain this, then update the widget.',
    "I can't share it now, but I will later.", 'I’m adjusting the threshold.', 'Let me handle the rest.', "I'll send it now, ok?",
    'ผมดูแลเรื่องนี้อยู่ครับ', 'เราติดตามเรื่องนี้อยู่', 'ดิฉันรับเรื่องไว้ค่ะ', 'หนูปรับเกณฑ์ให้ค่ะ', 'จะปรับเกณฑ์การแจ้งเตือนครับ',
    'เดี๋ยวดูต่อให้นะครับ', 'ขอปรับ Dashboard ใหม่นะครับ', 'รับทราบครับ จะติดตามผลต่อ', 'ผมอธิบายตัวเลือกได้ แล้วจะส่งให้', 'ผมอธิบายได้และจัดการต่อ',
    // Past forms added to the third-person completion rule.
    'Request carried out.', 'The update was implemented.', 'Took action on the request.', 'The changes were performed.',
    // Former must-pass cases (first person, not on the allowlist).
    'ผมแนะนำให้เริ่มจากดูยอดขายรายสาขาก่อน แล้วค่อยสร้าง Dashboard', 'ผมช่วยอธิบายได้ครับ Dashboard จะดึงข้อมูลใหม่เมื่อเปิด',
    'หากต้องการ ผมสามารถช่วยเตรียมข้อเสนอให้ตรวจก่อนได้', 'ผมตั้งใจช่วยให้คุณตัดสินใจได้ง่ายขึ้น', 'ใช่ครับ ผมเข้าใจ ตอนนี้ยังไม่ได้ส่งอะไร',
    'ผมส่งเสริมให้ตรวจข้อมูลก่อนตัดสินใจ', 'I will explain how sharing works.', "I'm ready to help with sales questions.", "I haven't saved anything.",
    'I can help you understand the difference between a Result and a Dashboard.', 'Let me know whether the report should be shared.',
    "I'll do my best to explain the difference.", 'Let me know if you want the dashboard updated.', "I'll explain how Monitors work.",
    'Let me summarize the options.', 'Let me clarify the difference between a Result and a Dashboard.', "I'll answer that briefly.",
    'I will not send anything without your confirmation.', 'Let me know which region you want.', 'ผมจะอธิบายความแตกต่างให้ฟังครับ',
  ])('G8 blocks the assistant-voice sentence %s', prose => expect(hasActionClaim(prose)).toBe(true));

  it.each([
    // The exact allowlist, whole sentence, nothing after the explanation's object.
    'I can explain the options.', 'Let me explain how Monitors work.', 'I can summarize the difference between a Result and a Dashboard.',
    "I'm not sure which region you mean.", "I don't have access to payroll data.", "I can't send real emails.", 'I cannot access external systems.',
    "Sorry, I can't access that data.", 'I can explain that for you.',
    'ผมอธิบายความแตกต่างได้ครับ', 'ขออธิบายสั้น ๆ นะครับ', 'ผมขออธิบายสั้น ๆ นะครับ', 'ไม่แน่ใจว่าหมายถึงภาคไหน', 'ผมไม่แน่ใจว่าหมายถึงภาคไหนครับ',
    'ไม่มีข้อมูลเงินเดือนในระบบ',
    // Offers phrased as questions.
    'Shall I send it to the East manager?', 'Should I go ahead and create it?', 'If you want, shall I prepare it?', 'ต้องการให้ผมเตรียม Dashboard ไหมครับ',
    'ผมเตรียม Dashboard ให้ดีไหมครับ', 'จะดูยอดขายของสาขานี้ไหม', 'จะส่งให้ใครครับ?',
    // Third-person product descriptions and non-subject first person.
    'Dashboard จะดึงข้อมูลใหม่ทุกครั้งที่เปิด', 'Results are snapshots.', 'Dashboards refresh whenever you open them.', 'The system will ask you to confirm first.',
    'ระบบจะขอให้คุณยืนยันก่อน', 'คุณจะเห็นผลใน History หลังยืนยัน', 'ขอบเขตของบัญชีนี้ครอบคลุมยอดขายและสต็อก', 'Tell me which region you want.',
    'ครับผม ข้อมูลนี้เป็น snapshot', 'Monitor จะตรวจยอดขายทุกวันและแจ้งเตือนเมื่อต่ำกว่าเกณฑ์',
  ])('G8 keeps the allowlisted / question / third-person text %s', prose => expect(hasActionClaim(prose)).toBe(false));

  // Third-person future effect without a stated condition promises an effect no step ran.
  it.each(['Your dashboard will be updated shortly.', 'The report will be sent to your team.', 'Your changes are going to be saved now.',
    'Dashboard จะถูกอัปเดตเร็ว ๆ นี้', 'รายงานจะถูกส่งให้ทีมของคุณ', 'Your dashboard will update shortly.', 'Your dashboard will update shortly, and it refreshes daily.', 'Your dashboard will update shortly, okay?', 'The report will go out to your team today.', 'Dashboard จะอัปเดตเร็ว ๆ นี้', 'รายงานจะส่งถึงทีมภายในวันนี้'])('blocks the third-person future effect %s', prose => expect(hasActionClaim(prose)).toBe(true));
  it.each(['The dashboard will be refreshed when you open it.', 'Changes will be saved only after you confirm.', 'Results will be shared once you approve the proposal.',
    'Dashboard จะถูกอัปเดตทุกครั้งที่เปิด', 'Monitor จะตรวจยอดขายทุกวัน', 'The dashboard will refresh when you open it.', 'The Monitor will send an alert daily if sales drop.', 'Dashboard จะอัปเดตทุกครั้งที่เปิด'])('keeps the conditional / descriptive future %s', prose => expect(hasActionClaim(prose)).toBe(false));
  it('treats the ยังไงก็ได้ idiom as no question (assistant voice still blocks)', () => expect(hasActionClaim('ผมจะช่วยคุณยังไงก็ได้ครับ')).toBe(true));

  // Thai questions need no "?": a question word marks them (unless the unit also states completion).
  it.each(['จะส่งให้ใครครับ', 'ผมจะเตรียมให้ที่ไหนดีครับ', 'ต้องการดูภาคไหนครับ'])('G8 keeps the Thai question %s', prose => expect(hasActionClaim(prose)).toBe(false));
  it('G8 still blocks a Thai "question word" sentence that states completion', () => expect(hasActionClaim('ผมส่งให้ทุกคนที่ไหนแล้วครับ')).toBe(true));

  // Follow-up chips are the USER's voice: the assistant-voice rule does not apply there, completion / promise rules still do.
  it('keeps user-voice follow-up chips and still drops claiming ones', () => {
    expect(modelTextSafe('follow_up', 'ขอดูยอดขายภาคตะวันออก')).toBe(true);
    expect(modelTextSafe('follow_up', 'I want to see sales by region')).toBe(true);
    expect(modelTextSafe('follow_up', 'ส่งรายงานให้ทีมเรียบร้อยแล้ว')).toBe(false);
    expect(modelTextSafe('conversation', 'ขอดูยอดขายภาคตะวันออก')).toBe(false);
  });
});

/** G5: ONE completion-claim gate covers every model-text surface; each surface's real checker rejects a claim. */
describe('modelTextSafe covers every model-text surface', () => {
  const CHECKERS: Record<ModelTextSurface, (text: string) => boolean> = {
    conversation: text => modelTextSafe('conversation', text),
    clarify: text => isSafeClarificationText(text, [], [], []),
    follow_up: text => isSafeFollowUp(text, []),
    title: text => isSafeConversationTitle(text, []),
    // G6: the surfaces gated at their own sites (validate, Dashboard builders, lookup executor) use modelTextSafe itself.
    product_help: text => modelTextSafe('product_help', text),
    dashboard_title: text => modelTextSafe('dashboard_title', text),
    artifact_title: text => modelTextSafe('artifact_title', text),
    visualization_text: text => modelTextSafe('visualization_text', text),
    staged_text: text => modelTextSafe('staged_text', text),
    lookup_query: text => modelTextSafe('lookup_query', text),
  };
  it('enumerates exactly the registered surfaces', () => expect(Object.keys(CHECKERS).sort()).toEqual([...MODEL_TEXT_SURFACES].sort()));
  const CLAIMS = ['จัดให้แล้วครับ ต้องการอะไรเพิ่มเติม?', 'All set', 'Dashboard ใช้งานได้แล้วครับ', 'I made the requested changes', 'Your dashboard is up and running'];
  for (const surface of MODEL_TEXT_SURFACES) {
    it.each(CLAIMS)(`${surface} rejects %s`, claim => expect(CHECKERS[surface](claim)).toBe(false));
    it(`${surface} keeps a plain question`, () => expect(CHECKERS[surface]('ต้องการดูยอดขายภาคไหนครับ')).toBe(true));
  }
});
