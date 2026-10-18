import { SITE } from "@/lib/site";

/** `irm <site>/install.ps1 | iex` follows this redirect to the Windows installer in the repo. */
export function GET() {
  return Response.redirect(SITE.installScriptWindows, 307);
}
