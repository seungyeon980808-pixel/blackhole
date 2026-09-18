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

type DraftStatus = "pending" | "synced" | "error";

interface DraftMessage {
  readonly id: number;
  readonly text: string;
  readonly status: DraftStatus;
  readonly filename: string | null;
}

const draftStatusLabel: Readonly<Record<DraftStatus, string>> = {
  pending: "대기 중",
  synced: "동기화됨",
  error: "실패 · 다시 동기화"
};

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
    <ol class="quick-capture__thread" data-testid="capture-thread" aria-label="동기화 대기 기록" aria-live="polite">
      <li class="quick-capture__empty">아직 쌓인 기억이 없습니다.</li>
    </ol>
    <form class="quick-capture__form">
      <label class="visually-hidden" for="quick-capture-message">인박스에 남길 기록</label>
      <textarea id="quick-capture-message" maxlength="20000" rows="3" placeholder="기억 입력" ${disabled ? "disabled" : ""}></textarea>
      <div class="quick-capture__actions">
        <button type="submit" data-action="add" ${disabled ? "disabled" : ""}>기록 추가</button>
        <button type="button" data-action="sync" disabled>동기화 (0)</button>
      </div>
      <p class="quick-capture__feedback" role="status" aria-live="polite"></p>
    </form>`;

  const thread = host.querySelector<HTMLOListElement>('[data-testid="capture-thread"]');
  const form = host.querySelector<HTMLFormElement>("form");
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  const addButton = host.querySelector<HTMLButtonElement>('[data-action="add"]');
  const syncButton = host.querySelector<HTMLButtonElement>('[data-action="sync"]');
  const feedback = host.querySelector<HTMLElement>(".quick-capture__feedback");
  if (!thread || !form || !input || !addButton || !syncButton || !feedback) return;

  let drafts: DraftMessage[] = [];
  let nextId = 1;
  let syncing = false;
  let hasSynced = false;

  const render = (): void => {
    const unsyncedCount = drafts.filter((draft) => draft.status !== "synced").length;
    thread.innerHTML = drafts.length === 0
      ? `<li class="quick-capture__empty">아직 쌓인 기억이 없습니다.</li>`
      : drafts.map((draft) => {
        const filename = draft.filename ? ` · ${escapeHtml(draft.filename)}` : "";
        return `<li class="quick-capture__message" data-message-status="${draft.status}">
          <p>${escapeHtml(draft.text)}</p>
          <small>${draftStatusLabel[draft.status]}${filename}</small>
        </li>`;
      }).join("");
    addButton.disabled = disabled || syncing;
    input.disabled = disabled || syncing;
    syncButton.disabled = disabled || syncing || unsyncedCount === 0;
    syncButton.textContent = syncing
      ? "동기화 중..."
      : unsyncedCount > 0
        ? `동기화 (${unsyncedCount})`
        : hasSynced
          ? "동기화 완료"
          : "동기화 (0)";
  };

  const syncDrafts = async (): Promise<void> => {
    if (syncing) return;
    syncing = true;
    render();
    let delivered = 0;
    while (true) {
      const draft = drafts.find((candidate) => candidate.status !== "synced");
      if (!draft) break;
      try {
        const result = await dependencies.capture(draft.text);
        drafts = drafts.map((candidate) => candidate.id === draft.id
          ? { ...candidate, status: "synced", filename: result.filename }
          : candidate);
        hasSynced = true;
        delivered += 1;
        render();
      } catch (error: unknown) {
        drafts = drafts.map((candidate) => candidate.id === draft.id
          ? { ...candidate, status: "error" }
          : candidate);
        feedback.textContent = errorMessage(error);
        break;
      }
    }
    syncing = false;
    render();
    if (delivered > 0 && drafts.every((draft) => draft.status === "synced")) {
      feedback.textContent = `${delivered}개 기록을 Inbox에 동기화했습니다.`;
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) {
      feedback.textContent = "내용을 입력해주세요.";
      return;
    }
    drafts = [...drafts, { id: nextId, text: message, status: "pending", filename: null }];
    nextId += 1;
    input.value = "";
    feedback.textContent = `${drafts.length}개 기록을 대기 중입니다.`;
    render();
    input.focus();
  });

  syncButton.addEventListener("click", () => {
    void syncDrafts();
  });

  render();
}
