import { NotificationProvider } from './provider.js'
import { EmailNotificationProvider } from './email.provider.js'
import { ConsoleNotificationProvider } from './console.provider.js'

export class NotificationService {
  private static providers: Record<string, NotificationProvider> = {
    email: new EmailNotificationProvider(),
    console: new ConsoleNotificationProvider(),
  }

  static getProvider(name?: string): NotificationProvider {
    const providerName = name || process.env.NOTIFICATION_PROVIDER || 'console'
    const provider = this.providers[providerName]
    
    if (!provider) {
      console.warn(`Provider ${providerName} not found, falling back to console`)
      return this.providers.console
    }
    
    return provider
  }

  static async send(recipient: string, subject: string, body: string, providerName?: string): Promise<void> {
    const provider = this.getProvider(providerName)
    await provider.send(recipient, subject, body)
  }
}
