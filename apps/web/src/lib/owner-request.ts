export function ownerRequestHeaders(
  token: string,
  additional?: HeadersInit,
): Headers {
  const headers = new Headers(additional);
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}
