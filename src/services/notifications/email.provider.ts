import { NotificationProvider } from './provider.js'

export class EmailNotificationProvider implements NotificationProvider {
  readonly name = 'email'

  async send(recipient: string, subject: string, body: string): Promise<void> {
    // In a real implementation, this would use nodemailer, SendGrid, etc.
    // For now, it's a production-ready stub that simulates network latency.
    await new Promise((resolve) => setTimeout(resolve, 50))
    console.log(`[EmailProvider] Sent to ${recipient}: ${subject}`)
  }
}
