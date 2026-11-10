import Capacitor
import Foundation
import MachO

/// Module 4 — détection d'appareil modifié (iOS) pour les fonctions sensibles.
/// Signaux : jailbreak (fichiers et schémas connus, écriture hors du bac à sable, bibliothèques injectées),
/// simulateur, débogueur attaché. Le verdict est remonté au serveur, qui refuse lui-même le QR dynamique, le
/// paiement et la prolongation d'un appareil compromis. Aucune donnée personnelle ni identifiant matériel collecté.
@objc(MosoloIntegritePlugin)
public class MosoloIntegritePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MosoloIntegritePlugin"
    public let jsName = "MosoloIntegrite"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "verifier", returnType: CAPPluginReturnPromise)]

    private let chemins = [
        "/Applications/Cydia.app", "/Applications/Sileo.app", "/Library/MobileSubstrate/MobileSubstrate.dylib",
        "/bin/bash", "/usr/sbin/sshd", "/etc/apt", "/private/var/lib/apt/", "/var/jb", "/usr/bin/ssh",
    ]

    @objc func verifier(_ call: CAPPluginCall) {
        call.resolve([
            "racine": false,
            "jailbreak": jailbreak(),
            "emulateur": simulateur(),
            "debogage": debogueur(),
            "signatureAlteree": false,
        ])
    }

    private func jailbreak() -> Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        if chemins.contains(where: { FileManager.default.fileExists(atPath: $0) }) { return true }
        let essai = "/private/mosolo-essai-\(UUID().uuidString)"
        if (try? "x".write(toFile: essai, atomically: true, encoding: .utf8)) != nil {
            try? FileManager.default.removeItem(atPath: essai)
            return true
        }
        for i in 0..<_dyld_image_count() {
            if let nom = _dyld_get_image_name(i), String(cString: nom).lowercased().contains("substrate") { return true }
        }
        return false
        #endif
    }

    private func simulateur() -> Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    private func debogueur() -> Bool {
        var info = kinfo_proc()
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        var taille = MemoryLayout<kinfo_proc>.stride
        let r = sysctl(&mib, UInt32(mib.count), &info, &taille, nil, 0)
        return r == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
    }
}
