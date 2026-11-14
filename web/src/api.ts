declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        ready: () => void;
        expand: () => void;
        requestWriteAccess?: (callback: (granted: boolean) => void) => void;
      };
    };
  }
}
export function devUser() {
  return localStorage.getItem("dev-user") || "1001";
}
export async function request<T>(
  path: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: "tma " + (window.Telegram?.WebApp.initData || ""),
  };
  if (localStorage.getItem("dev-enabled") === "true")
    headers["X-Dev-User"] = devUser();
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = key || crypto.randomUUID();
  }
  const response = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Не удалось связаться с сервером");
  return data;
}
