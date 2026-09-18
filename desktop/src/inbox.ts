export type InboxState = "connected" | "unavailable";

export interface InboxStatus {
  readonly state: InboxState;
  readonly path: string | null;
  readonly detail: string;
}

export interface InboxCaptureResult {
  readonly filename: string;
}

export interface InboxCaptureDependencies {
  readonly status: InboxStatus;
  readonly capture: (message: string) => Promise<InboxCaptureResult>;
}

export const unavailableInboxCapture: InboxCaptureDependencies = {
  status: {
    state: "unavailable",
    path: null,
    detail: "Google Drive 동기화 Inbox를 찾을 수 없습니다."
  },
  capture: async () => {
    throw new Error("Google Drive 동기화 Inbox를 사용할 수 없습니다.");
  }
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Inbox 저장에 실패했습니다.";
}

export function mountInboxCapture(host: HTMLElement, dependencies: InboxCaptureDependencies): void {
  const { status } = dependencies;
  const disabled = status.state === "unavailable";
  const location = status.path ? `<small>${escapeHtml(status.path)}</small>` : "";
  host.innerHTML = `<h2>빠른 기록</h2>
    <p class="quick-capture__detail">${escapeHtml(status.detail)}</p>
    ${location}
    <form>
      <label class="visually-hidden" for="quick-capture-message">인박스에 남길 기록</label>
      <textarea id="quick-capture-message" maxlength="20000" rows="4" placeholder="내용 입력" ${disabled ? "disabled" : ""}></textarea>
      <button type="submit" ${disabled ? "disabled" : ""}>인박스에 저장</button>
      <p class="quick-capture__feedback" role="status" aria-live="polite"></p>
    </form>`;

  const form = host.querySelector("form");
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  const button = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  const feedback = host.querySelector<HTMLElement>(".quick-capture__feedback");
  if (!form || !input || !button || !feedback) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) {
      feedback.textContent = "내용을 입력해주세요.";
      return;
    }
    button.disabled = true;
    feedback.textContent = "저장 중...";
    try {
      const result = await dependencies.capture(message);
      input.value = "";
      feedback.textContent = `Inbox에 저장했습니다: ${result.filename}`;
    } catch (error: unknown) {
      feedback.textContent = errorMessage(error);
    } finally {
      button.disabled = disabled;
    }
  });
}
