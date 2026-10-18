import { ImageResponse } from "next/og";
import { HalftoneMark } from "@/lib/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the "cm" halftone monogram, white on pink. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", background: "#ff5c8d" }}>
        <HalftoneMark cell={4.4} monogram />
      </div>
    ),
    size,
  );
}
