import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { ShowcaseChips } from '../components/biztania/demo-guide';
import { roleShowcase, showcase, showcaseById, unsupportedDemoHeading, unsupportedDemoReply } from '../lib/demo/showcase';
import { bindWorkCatalogEntry } from '../lib/router/demo-plans';
import { turnPlanSchema } from '../lib/router/turn-plan';

function expectPlanGroundedInPrompt(value: unknown, prompt: string): void {
  if (Array.isArray(value)) {
    value.forEach(child => expectPlanGroundedInPrompt(child, prompt));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (key === 'evidenceText' && typeof child === 'string') expect(prompt).toContain(child);
    if (key === 'sourceText' && child && typeof child === 'object' && 'start' in child && 'end' in child && 'text' in child) {
      const span = child as { start: number; end: number; text: string };
      expect(prompt.slice(span.start, span.end)).toBe(span.text);
    }
    expectPlanGroundedInPrompt(child, prompt);
  }
}

describe('id-bound demo plans', () => {
  it.each(showcase)('$role showcase $id has a strict, prompt-grounded TurnPlan', item => {
    expect(turnPlanSchema.parse(item.plan)).toEqual(item.plan);
    expectPlanGroundedInPrompt(item.plan, item.prompt);
  });

  it('resolves showcase cards only for their owning role and returns that card plan', () => {
    for (const item of showcase) {
      expect(showcaseById(item.role, item.id)).toMatchObject({ id: item.id, plan: item.plan });
    }
    expect(showcaseById('east_manager', 'hr-employee')).toBeUndefined();
    expect(showcaseById('executive', 'unknown-card')).toBeUndefined();
  });

  it('showcase chips pass the selected card object with its stable id', () => {
    const onSelect = vi.fn();
    const chips = ShowcaseChips({ role: 'executive', disabled: false, onSelect });
    type ChipProps = { 'data-showcase-id': string; onClick: () => void };
    const buttons = chips.props.children as ReactElement<ChipProps>[];
    expect(buttons).toHaveLength(roleShowcase('executive').length);
    buttons.forEach((button, index) => {
      const item = roleShowcase('executive')[index];
      expect(button.props['data-showcase-id']).toBe(item.id);
      button.props.onClick();
      expect(onSelect).toHaveBeenLastCalledWith(item);
    });
  });

  it.each([
    { id: 'retail.sales-analysis', prompt: 'วิเคราะห์ภาพรวมยอดขายและเป้าหมายในภูมิภาคตะวันออก' },
    { id: 'retail.sales-below-target', prompt: 'Review all branches below target.' },
    { id: 'retail.sales-achievement', prompt: 'ยอดขายรวมทำได้กี่เปอร์เซ็นต์ของเป้าในภูมิภาคตะวันออก' },
    { id: 'retail.dashboard-create', prompt: 'Prepare a dashboard.' },
    { id: 'hr.employee-search.E024', prompt: 'Find employee E024.' },
    { id: 'hr.badge-revoke.C102', prompt: 'Review badge C102 removal.' },
    { id: 'catalog.badge_reason_required', prompt: 'Please provide a badge removal reason.' },
  ])('binds work-catalog entry $id to a server plan', entry => {
    const bound = bindWorkCatalogEntry(entry);
    expect(bound).toBeDefined();
    expect(bound?.id).toBe(entry.id);
    expect(turnPlanSchema.parse(bound?.plan)).toEqual(bound?.plan);
    expectPlanGroundedInPrompt(bound?.plan, entry.prompt);
  });

  it('returns the selected role showcase as the unsupported typed-text guidance', () => {
    const reply = unsupportedDemoReply('east_manager');
    expect(reply).toContain(unsupportedDemoHeading);
    for (const item of roleShowcase('east_manager')) expect(reply).toContain(item.title);
    for (const item of showcase.filter(item => item.role !== 'east_manager')) expect(reply).not.toContain(item.title);
  });
});
