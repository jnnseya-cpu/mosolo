package cd.kinshasa.mosolo;

import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Debug;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * Module 4 — détection d'appareil modifié (Android) pour les fonctions sensibles.
 * Signaux : racine (binaires su, Magisk, clés de test), émulateur, débogueur attaché ou application débogable.
 * Le verdict est remonté au serveur (POST /v1/public/application/installations/{id}/integrite), qui refuse
 * lui-même le QR dynamique, le paiement et la prolongation d'un appareil compromis : l'interface n'est pas le contrôle.
 * Aucune donnée personnelle ni identifiant matériel n'est collecté.
 */
@CapacitorPlugin(name = "MosoloIntegrite")
public class MosoloIntegritePlugin extends Plugin {

    private static final String[] CHEMINS_RACINE = {
        "/system/app/Superuser.apk", "/sbin/su", "/system/bin/su", "/system/xbin/su", "/data/local/xbin/su",
        "/data/local/bin/su", "/system/sd/xbin/su", "/system/bin/failsafe/su", "/data/local/su", "/su/bin/su",
        "/data/adb/magisk", "/sbin/.magisk"
    };

    @PluginMethod
    public void verifier(PluginCall call) {
        JSObject r = new JSObject();
        r.put("racine", racine());
        r.put("jailbreak", false);
        r.put("emulateur", emulateur());
        r.put("debogage", debogage());
        r.put("signatureAlteree", false);
        call.resolve(r);
    }

    static boolean racine() {
        String tags = Build.TAGS;
        if (tags != null && tags.contains("test-keys")) return true;
        for (String p : CHEMINS_RACINE) {
            if (new File(p).exists()) return true;
        }
        return false;
    }

    static boolean emulateur() {
        return Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.contains("emulator")
            || Build.MODEL.contains("Emulator") || Build.MODEL.contains("Android SDK built for")
            || Build.HARDWARE.contains("goldfish") || Build.HARDWARE.contains("ranchu")
            || Build.PRODUCT.contains("sdk") || Build.MANUFACTURER.contains("Genymotion");
    }

    private boolean debogage() {
        boolean debuggable = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        return Debug.isDebuggerConnected() || debuggable;
    }
}
