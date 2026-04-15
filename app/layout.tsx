import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" })
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: 'nodepad v2',
  description: 'Spatial thinking canvas. Augment is the one AI verb.',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Do NOT use viewportFit:'cover' — it extends content behind Safari address bar
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`} suppressHydrationWarning>
        {/* Set --app-height from window.innerHeight so the app fits the visible viewport on iPad Safari */}
        <script dangerouslySetInnerHTML={{ __html: `
          function setAppHeight(){document.documentElement.style.setProperty('--app-height',window.innerHeight+'px')}
          setAppHeight();window.addEventListener('resize',setAppHeight);window.addEventListener('orientationchange',function(){setTimeout(setAppHeight,100)});
        `}} />
        {children}
      </body>
    </html>
  )
}
