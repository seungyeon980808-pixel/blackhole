/**
 * 비밀 같은 문장 (Mac의 src-tauri/src/secret.rs `guess`의 「확실함」과 같은 기준): 비번·카드번호·계좌·주민번호 같은
 * 말과 코드 모양 값이 함께 있을 때. 휴대폰은 키체인이 없어서 이런 문장은 보내지 않는다(2026-10-27 밤 안정화).
 */
const KEY = /비번|비밀번호|패스워드|암호|password|passwd|\bpw\b|\bpin\b|핀\s*번호|카드\s*번호|카드|보안\s*코드|cvc|cvv|otp|인증\s*키|api\s*key|api키|토큰|token|계좌\s*번호|계좌|공인인증|아이디|계정|주민\s*(?:등록)?\s*번호|여권\s*번호|면허\s*번호|운전\s*면허|외국인\s*등록\s*번호/i;
const DATE = /^\d{1,4}[:./-]\d{1,2}([:./-]\d{1,4})?$/;

export function looksSecret(text: string): boolean {
  const t = text.trim();
  if (!t || t.split("\n").length > 3 || t.length > 200 || !KEY.test(t)) return false;
  return t.split(/[\s=：]+/).some((raw) => {
    const v = raw.replace(/^[:"'(「]+|[,."')」]+$/g, "");
    if (v.length < 4 || /[가-힣ㄱ-ㅎ]/.test(v) || v.startsWith("http") || DATE.test(v)) return false;
    const digits = (v.match(/\d/g) ?? []).length;
    const letters = (v.match(/[A-Za-z]/g) ?? []).length;
    const symbols = (v.match(/[!-/:-@[-`{-~]/g) ?? []).length;
    return digits + letters + symbols === v.length && (digits > 0 || symbols > 0 || letters >= 6);
  });
}
