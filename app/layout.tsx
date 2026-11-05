import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "UPLIVANTA — Let kindness move",
  description: "A global network connecting people who need help with people willing to help.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}
