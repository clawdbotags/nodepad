import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" })
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: 'nodepad v2',
  description: 'Spatial thinking canvas. Augment is the one AI verb.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // On mobile the on-screen keyboard must resize the layout (so absolute
  // bottom-0 elements stay visible). Do NOT use viewportFit:'cover' — that
  // extends content under the Safari browser chrome.
  interactiveWidget: 'resizes-content',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`} suppressHydrationWarning>
        {/* Write visualViewport.height (the actual visible pixels, which
            excludes the Safari / Chrome browser bars) into --app-height so the
            root flex container uses the real visible area rather than 100dvh,
            which lags behind on iOS Safari and lets the bottom UI render
            behind the URL bar. Falls back to innerHeight on older browsers. */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){
            function setAppHeight(){
              var h = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
              document.documentElement.style.setProperty('--app-height', h + 'px');
            }
            setAppHeight();
            if (window.visualViewport) {
              window.visualViewport.addEventListener('resize', setAppHeight);
              window.visualViewport.addEventListener('scroll', setAppHeight);
            }
            window.addEventListener('resize', setAppHeight);
            window.addEventListener('orientationchange', function(){ setTimeout(setAppHeight, 150) });
          })();
        `}} />
        {children}
      </body>
    </html>
  )
}
