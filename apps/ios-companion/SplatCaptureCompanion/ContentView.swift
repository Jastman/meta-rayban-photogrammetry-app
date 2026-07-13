import SwiftUI
import UIKit
import AVFoundation

struct ContentView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    statusCard
                    preview
                    captureCard
                    reconstructionCard
                }
                .padding()
            }
            .navigationTitle("Splat Capture")
            .overlay {
                if model.isBusy {
                    ProgressView().padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .alert("Action needed", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.errorMessage ?? "")
            }
        }
    }

    private var statusCard: some View {
        GroupBox("Setup and glasses") {
            VStack(alignment: .leading, spacing: 10) {
                Label(model.configurationMessage, systemImage: "checklist")
                statusRow("Registration", model.registration.rawValue)
                statusRow("Camera permission", model.cameraPermission.rawValue)
                statusRow("Devices found", "\(model.deviceCount)")
                statusRow("Session", model.sessionPhase.rawValue)
                if model.captureInputMode == .iphoneFallback, let fallbackMessage = model.fallbackMessage {
                    Label(fallbackMessage, systemImage: "iphone.gen3")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Text(model.setupGuidance)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !model.camera.isMock {
                    HStack {
                        Button(model.registration == .registered ? "Registered" : "Register with Meta AI") {
                            Task { await model.register() }
                        }
                        .disabled(!model.canRegister)
                        Button(model.cameraPermission == .granted ? "Camera granted" : "Request camera") {
                            Task { await model.requestCameraPermission() }
                        }
                        .disabled(!model.canRequestCamera)
                    }
                    .buttonStyle(.bordered)
                }
                HStack {
                    if model.captureInputMode == .iphoneFallback {
                        Label("iPhone fallback active", systemImage: "iphone.gen3")
                            .foregroundStyle(.orange)
                    } else if model.sessionPhase == .paused {
                        Button("Resume") { Task { await model.resumeCaptureSession() } }
                            .buttonStyle(.borderedProminent)
                    } else if model.sessionPhase == .started {
                        Button("Pause") { model.pauseCaptureSession() }
                            .buttonStyle(.borderedProminent)
                    } else {
                        Button("Start session") { Task { await model.startCaptureSession() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(!model.canStartSession)
                    }
                    Button("Stop") { model.stopCaptureSession() }
                        .buttonStyle(.bordered)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var preview: some View {
        GroupBox("Live glasses preview") {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(.black)
                if model.captureInputMode == .iphoneFallback {
                    if let previewSession = model.fallbackPreviewSession {
                        FallbackCameraPreview(session: previewSession)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        VStack {
                            HStack {
                                Label("iPhone fallback", systemImage: "iphone.gen3.camera")
                                    .font(.caption.bold())
                                    .padding(8)
                                    .background(.black.opacity(0.55), in: Capsule())
                                    .foregroundStyle(.white)
                                Spacer()
                            }
                            Spacer()
                            Text("Glasses live preview unavailable. One tap on capture uses iPhone camera.")
                                .font(.caption)
                                .padding(8)
                                .background(.black.opacity(0.55), in: Capsule())
                                .foregroundStyle(.white)
                        }
                        .padding(12)
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "iphone.gen3.camera")
                                .font(.largeTitle)
                            Text("Starting iPhone fallback camera...")
                                .font(.headline)
                        }
                        .foregroundStyle(.white)
                    }
                } else if let image = model.previewImage {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "eyeglasses").font(.largeTitle)
                        Text("Waiting for frames")
                    }
                    .foregroundStyle(.white)
                }
            }
            .frame(height: 280)
        }
    }

    private var captureCard: some View {
        GroupBox("Deterministic 36-station capture") {
            VStack(alignment: .leading, spacing: 10) {
                Text("\(model.currentStation.ring.title) ring • station \(model.currentStation.stationIndex + 1) of 12 • \(model.currentStation.angleDeg)°")
                    .font(.headline)
                ProgressView(value: Double(model.completedStationCount), total: 36)
                ForEach(CaptureRing.allCases, id: \.self) { ring in
                    statusRow("\(ring.title) ring", "\(model.ringProgress[ring] ?? 0) / 12")
                }
                Button(model.captureInputMode == .iphoneFallback ? "Capture station photo (iPhone)" : "Capture station photo") {
                    Task { await model.captureCurrentStation() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.sessionPhase != .started || model.completedStationCount == 36)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private struct FallbackCameraPreview: UIViewRepresentable {
        let session: AVCaptureSession

        func makeUIView(context: Context) -> PreviewView {
            let view = PreviewView()
            view.previewLayer.videoGravity = .resizeAspectFill
            view.previewLayer.session = session
            return view
        }

        func updateUIView(_ uiView: PreviewView, context: Context) {
            uiView.previewLayer.session = session
        }
    }

    private final class PreviewView: UIView {
        override class var layerClass: AnyClass {
            AVCaptureVideoPreviewLayer.self
        }

        var previewLayer: AVCaptureVideoPreviewLayer {
            guard let layer = layer as? AVCaptureVideoPreviewLayer else {
                fatalError("Expected AVCaptureVideoPreviewLayer backing layer.")
            }
            return layer
        }
    }

    private var reconstructionCard: some View {
        GroupBox("Reconstruction") {
            VStack(alignment: .leading, spacing: 10) {
                if let active = model.activeReconstruction {
                    reconstructionJobCard(
                        title: "Active job",
                        job: active,
                        emphasize: true
                    )
                } else {
                    statusRow("State", model.reconstructionStatus?.rawValue ?? "not submitted")
                    if let progress = model.reconstructionProgress {
                        statusRow("Progress", progressDisplay(progress))
                    }
                    Text(model.reconstructionMessage).foregroundStyle(.secondary)
                }
                if !model.previousReconstructions.isEmpty {
                    Divider()
                    Text("Previous reconstructions")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(model.previousReconstructions.prefix(5)) { item in
                        reconstructionJobCard(
                            title: timestampTitle(for: item),
                            job: item,
                            emphasize: false
                        )
                    }
                }
                Button(model.notificationsEnabled ? "Completion alerts enabled" : "Enable completion alerts") {
                    Task { await model.enableNotifications() }
                }
                .buttonStyle(.bordered)
                .disabled(model.notificationsEnabled)
                Button(model.isSubmittingReconstruction ? "Submitting..." : "Submit reconstruction") {
                    Task { await model.submitReconstruction() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.canSubmitReconstruction)
                Text("Local alerts require this companion session to remain active. Production background completion needs APNs and server push.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func reconstructionJobCard(
        title: String,
        job: AppModel.ReconstructionJobViewData,
        emphasize: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.caption.weight(.semibold))
                Spacer()
                Text(String(job.jobID.prefix(8)))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            statusRow("State", job.status.rawValue)
            if let progress = job.progress {
                statusRow("Progress", progressDisplay(progress))
                ProgressView(value: min(max(progress, 0), 100), total: 100)
            }
            Text(job.message)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let result = job.result {
                Text("Provider: \(result.provider.rawValue)")
                    .font(.caption)
                if let format = result.format {
                    Text("Format: \(format)")
                        .font(.caption)
                }
                if let notes = result.notes, !notes.isEmpty {
                    Text(notes)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let thumbnailURL = result.thumbnailURL {
                    AsyncImage(url: thumbnailURL) { phase in
                        if let image = phase.image {
                            image
                                .resizable()
                                .scaledToFit()
                        } else if phase.error != nil {
                            Text("Preview unavailable")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            ProgressView()
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 80)
                    .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
                }
                if let resultURL = result.resultURL {
                    Link("Open result", destination: resultURL)
                        .font(.subheadline.weight(.semibold))
                }
            }
        }
        .padding(10)
        .background(
            emphasize ? AnyShapeStyle(Color.blue.opacity(0.08)) : AnyShapeStyle(.quaternary.opacity(0.2)),
            in: RoundedRectangle(cornerRadius: 10)
        )
    }

    private func progressDisplay(_ progress: Double) -> String {
        "\(Int(progress.rounded()))%"
    }

    private func timestampTitle(for job: AppModel.ReconstructionJobViewData) -> String {
        "Submitted \(job.submittedAt.formatted(date: .abbreviated, time: .shortened))"
    }

    private func statusRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).foregroundStyle(.secondary).textCase(.uppercase)
        }
    }
}
