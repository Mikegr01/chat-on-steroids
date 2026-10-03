import { expect, it } from 'vitest';
import { RECOMMENDED_SKILLS } from '../src/shared/recommended-skills.js';
import { MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_NAME_CHARS, SKILL_ID_PATTERN } from '../src/shared/skills.js';

it('validates that all recommended skills meet the strict quality contract', () => {
  expect(RECOMMENDED_SKILLS.length).toBeGreaterThanOrEqual(18);

  for (const item of RECOMMENDED_SKILLS) {
    expect(item.id).toMatch(SKILL_ID_PATTERN);
    expect(item.name.length).toBeLessThanOrEqual(MAX_SKILL_NAME_CHARS);
    expect(item.name.trim()).not.toBe('');
    expect(item.description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_CHARS);
    expect(item.description.trim()).not.toBe('');
    expect(item.markdown).toContain(`name: ${JSON.stringify(item.name)}`);
    expect(item.markdown).toContain(`description: ${JSON.stringify(item.description)}`);

    // Ensure the markdown body contains substance
    const body = item.markdown.replace(/^---[\s\S]*?---\n/, '').trim();
    expect(body.length).toBeGreaterThanOrEqual(100);
    expect(body).toMatch(/^#\s+.+/m);

    // Ensure no recommended skill contains unsafe destructive git commands
    expect(body).not.toMatch(/git\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s*\.)/i);
  }
});

it('verifies that enhanced skills define explicit Trigger and Non-Trigger contracts', () => {
  const codeReview = RECOMMENDED_SKILLS.find(s => s.id === 'code-review');
  expect(codeReview).toBeDefined();
  expect(codeReview?.markdown).toContain('## Trigger & Scope');
  expect(codeReview?.markdown).toMatch(/-\s+\*\*Trigger:\*\*/);
  expect(codeReview?.markdown).toMatch(/-\s+\*\*Non-Trigger:\*\*/);
  // Independent verification and adversarial scan
  expect(codeReview?.markdown).toContain('CLAIMED');
  expect(codeReview?.markdown).toContain('OBSERVED');
  expect(codeReview?.markdown).toContain('VERIFIED');
  expect(codeReview?.markdown).toContain('Never discard uncommitted user work');
  expect(codeReview?.markdown).toContain('Validate commit boundary');
  // Non-trigger must forbid code authoring
  expect(codeReview?.markdown).toMatch(/Non-Trigger:.*(?:generating code|no change exists)/s);

  const autonomousDev = RECOMMENDED_SKILLS.find(s => s.id === 'autonomous-dev-workflow');
  expect(autonomousDev).toBeDefined();
  expect(autonomousDev?.markdown).toContain('## Trigger & Scope');
  expect(autonomousDev?.markdown).toMatch(/-\s+\*\*Trigger:\*\*/);
  expect(autonomousDev?.markdown).toMatch(/-\s+\*\*Non-Trigger:\*\*/);
  // Red -> Green discipline and layered verification
  expect(autonomousDev?.markdown).toContain('RED -> GREEN');
  expect(autonomousDev?.markdown).toContain('Never reset, stash, or discard uncommitted');
  expect(autonomousDev?.markdown).toContain('Layered verification');
  expect(autonomousDev?.markdown).toMatch(/Never use bypasses/i);
  // Non-trigger must delegate read-only reviews to code-review / review-agent
  expect(autonomousDev?.markdown).toMatch(/Non-Trigger:.*(?:read-only reviews|Code review)/s);
});

it('enforces role separation between engineering worker and independent reviewer', () => {
  const codeReview = RECOMMENDED_SKILLS.find(s => s.id === 'code-review');
  const autonomousDev = RECOMMENDED_SKILLS.find(s => s.id === 'autonomous-dev-workflow');

  expect(codeReview).toBeDefined();
  expect(autonomousDev).toBeDefined();

  // Reviewer is strictly read-only defect-first verification
  expect(codeReview?.markdown).toContain('read-only, defect-first verification');
  // Engineering worker coordinates implementation and test-driven repair
  expect(autonomousDev?.markdown).toContain('multi-step repository engineering');
  expect(autonomousDev?.markdown).toContain('Implement (GREEN)');
});
