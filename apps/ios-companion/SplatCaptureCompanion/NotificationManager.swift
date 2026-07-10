import Foundation
import UserNotifications

actor NotificationManager {
    private var notifiedJobs = Set<String>()

    func requestPermission() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    func notifySuccess(jobID: String, mock: Bool) async throws {
        guard notifiedJobs.insert(jobID).inserted else { return }
        let content = UNMutableNotificationContent()
        content.title = mock ? "Mock reconstruction complete" : "Splat reconstruction complete"
        content.body = "Your capture is ready to review."
        content.sound = .default
        let request = UNNotificationRequest(identifier: "reconstruction-\(jobID)", content: content, trigger: nil)
        try await UNUserNotificationCenter.current().add(request)
    }
}
