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
        {/* Use visualViewport.height (actual visible pixels, excludes Safari toolbar) */}
        <script dangerouslySetInnerHTML={{ __html: `
          function setAppHeight(){
            var h=window.visualViewport?window.visualViewport.height:window.innerHeight;
            document.documentElement.style.setProperty('--app-height',h+'px');
          }
          setAppHeight();
          if(window.visualViewport){
            window.visualViewport.addEventListener('resize',setAppHeight);
            window.visualViewport.addEventListener('scroll',setAppHeight);
          }
          window.addEventListener('resize',setAppHeight);
          window.addEventListener('orientationchange',function(){setTimeout(setAppHeight,150)});
        `}} />
        {children}
      </body>
    </html>
  )
}
