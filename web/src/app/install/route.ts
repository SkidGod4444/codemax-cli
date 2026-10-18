import { SITE } from "@/lib/site";

/** `curl -fsSL <site>/install | bash` follows this redirect to the installer in the repo. */
export function GET() {
  return Response.redirect(SITE.installScript, 307);
}
