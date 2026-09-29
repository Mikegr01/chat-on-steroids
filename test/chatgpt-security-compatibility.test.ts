import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');

type SecurityState = {
  required: boolean;
  reason: string;
  state: string;
  description?: string;
};

type SecurityError = {
  blocking?: boolean;
  state?: string;
  recoverable?: boolean;
};

type SecurityDomApi = {
  securityOrAuthRequired?: () => SecurityState | null;
  errors: () => SecurityError[];
  composerSubmitReady: () => boolean;
  insertPrompt: (value: string, mode: boolean, reject: (reason: string) => void) => boolean;
  send: () => Promise<boolean>;
};

function setupDom(html: string, url = 'https://chatgpt.com/c/test-chat', title = 'ChatGPT') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.document.title = title;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
    value() {
      return this.hidden || this.getAttribute('aria-hidden') === 'true' ? [] : [{ width: 100, height: 40 }];
    }
  });
  dom.window.eval(domSource);
  return {
    dom,
    CLF_DOM: Reflect.get(dom.window, 'CLF_DOM') as SecurityDomApi
  };
}

describe('ChatGPT Security and Challenge State Detection', () => {
  it('detects authentication/login required path', () => {
    const { CLF_DOM } = setupDom(
      '<div id="root"><main><div>Please sign in</div></main></div>',
      'https://chatgpt.com/auth/login'
    );
    const security = CLF_DOM.securityOrAuthRequired?.();
    expect(security).toMatchObject({
      required: true,
      reason: 'auth_required',
      state: 'SECURITY_OR_AUTH_REQUIRED'
    });
  });

  it('detects security checkpoint path', () => {
    const { CLF_DOM } = setupDom(
      '<div id="root"><main><div>Security checkpoint</div></main></div>',
      'https://chatgpt.com/checkpoint/'
    );
    const security = CLF_DOM.securityOrAuthRequired?.();
    expect(security).toMatchObject({
      required: true,
      reason: 'checkpoint_required',
      state: 'SECURITY_OR_AUTH_REQUIRED'
    });
  });

  it('detects Cloudflare Turnstile / Challenge container and interstitial title', () => {
    const challengeHtml = `
      <div id="root">
        <div id="challenge-stage">
          <iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/0/foo"></iframe>
        </div>
      </div>
    `;
    const { CLF_DOM } = setupDom(challengeHtml, 'https://chatgpt.com/', 'Just a moment...');
    const security = CLF_DOM.securityOrAuthRequired?.();
    expect(security).toMatchObject({
      required: true,
      reason: 'challenge_required',
      state: 'SECURITY_OR_AUTH_REQUIRED'
    });
  });

  it('detects Cloudflare access restricted / blocked page', () => {
    const blockedHtml = `
      <div id="cf-error-details" class="cf-error-details-wrapper">
        <h1>Error 1020: Access Denied</h1>
      </div>
    `;
    const { CLF_DOM } = setupDom(blockedHtml, 'https://chatgpt.com/', 'Access Denied');
    const security = CLF_DOM.securityOrAuthRequired?.();
    expect(security).toMatchObject({
      required: true,
      reason: 'access_blocked',
      state: 'SECURITY_OR_AUTH_REQUIRED'
    });
  });

  it('returns null on a normal, healthy ChatGPT workspace page', () => {
    const normalHtml = `
      <div id="root">
        <form data-chatgpt-composer>
          <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
          <button data-testid="send-button" type="submit">Send</button>
        </form>
      </div>
    `;
    const { CLF_DOM } = setupDom(normalHtml, 'https://chatgpt.com/c/12345678-1234-4234-8234-123456789abc');
    expect(CLF_DOM.securityOrAuthRequired?.()).toBeNull();
  });

  it('surfaces security/auth state as a blocking, non-recoverable error in CLF_DOM.errors()', () => {
    const { CLF_DOM } = setupDom(
      '<div id="challenge-stage"><div class="cf-turnstile"></div></div>',
      'https://chatgpt.com/'
    );
    const errors = CLF_DOM.errors();
    const securityError = errors.find(error =>
      error.blocking === true && error.state === 'SECURITY_OR_AUTH_REQUIRED'
    );
    expect(securityError).toBeDefined();
    expect(securityError?.recoverable).toBe(false);
  });

  it('prevents composer readiness, insertion, and send when security or auth is required', async () => {
    const { CLF_DOM } = setupDom(
      `
      <div id="root">
        <div id="challenge-stage"></div>
        <form data-chatgpt-composer>
          <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
          <button data-testid="send-button" type="submit">Send</button>
        </form>
      </div>
      `,
      'https://chatgpt.com/'
    );

    expect(CLF_DOM.composerSubmitReady()).toBe(false);

    let rejectionReason = '';
    const inserted = CLF_DOM.insertPrompt('test prompt', false, (reason: string) => {
      rejectionReason = reason;
    });
    expect(inserted).toBe(false);
    expect(rejectionReason).toBe('security_or_auth_required');

    const sent = await CLF_DOM.send();
    expect(sent).toBe(false);
  });
});
