package caderno.decuidado.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Guarda o refresh token em repouso com uma chave AES-256 do AndroidKeyStore.
 * Equivalente Android do DPAPI usado pelo launcher do Windows: o token nunca
 * é gravado em texto puro e não sai do aparelho.
 */
final class AuthStore {

    private static final String PREFS = "caderno_drive_auth";
    private static final String ALIAS = "caderno_drive_token_key";
    private static final String K_TOKEN = "refresh_token_enc";
    private static final String K_EMAIL = "email";
    private static final String K_IV = "iv";
    private static final String K_NATIVE = "native_token_enc";
    private static final String K_NATIVE_IV = "native_iv";
    private static final String K_NATIVE_EXP = "native_expires";

    private final SharedPreferences prefs;

    AuthStore(Context ctx) {
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized void saveToken(String refreshToken) {
        if (refreshToken == null || refreshToken.isEmpty()) return;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] enc = cipher.doFinal(refreshToken.getBytes(StandardCharsets.UTF_8));
            prefs.edit()
                    .putString(K_TOKEN, Base64.encodeToString(enc, Base64.NO_WRAP))
                    .putString(K_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                    .apply();
        } catch (Exception e) {
            // Sem cofre disponível, o login continua válido só nesta execução.
            prefs.edit().remove(K_TOKEN).remove(K_IV).apply();
        }
    }

    synchronized String token() {
        String enc = prefs.getString(K_TOKEN, null);
        String iv = prefs.getString(K_IV, null);
        if (enc == null || iv == null) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(),
                    new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            byte[] out = cipher.doFinal(Base64.decode(enc, Base64.NO_WRAP));
            return new String(out, StandardCharsets.UTF_8);
        } catch (Exception e) {
            // Chave invalidada (restauração/troca de tela): pede novo login.
            clear();
            return null;
        }
    }

    String email() {
        return prefs.getString(K_EMAIL, "");
    }

    void setEmail(String email) {
        prefs.edit().putString(K_EMAIL, email == null ? "" : email).apply();
    }

    /**
     * Access token do login nativo (Google Play Services). Diferente do
     * refresh token do fluxo Desktop, ele expira em ~1 h; guardamos o
     * vencimento para o app pedir Reconectar em vez de falhar em silêncio.
     */
    synchronized void saveNative(String token, long expiresAt) {
        if (token == null || token.isEmpty()) return;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] enc = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            prefs.edit()
                    .putString(K_NATIVE, Base64.encodeToString(enc, Base64.NO_WRAP))
                    .putString(K_NATIVE_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                    .putLong(K_NATIVE_EXP, expiresAt)
                    .apply();
        } catch (Exception e) {
            prefs.edit().remove(K_NATIVE).remove(K_NATIVE_IV).remove(K_NATIVE_EXP).apply();
        }
    }

    synchronized String nativeToken() {
        String enc = prefs.getString(K_NATIVE, null);
        String iv = prefs.getString(K_NATIVE_IV, null);
        if (enc == null || iv == null) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(),
                    new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            byte[] out = cipher.doFinal(Base64.decode(enc, Base64.NO_WRAP));
            return new String(out, StandardCharsets.UTF_8);
        } catch (Exception e) {
            clearNative();
            return null;
        }
    }

    synchronized long nativeExpiresAt() {
        return prefs.getLong(K_NATIVE_EXP, 0);
    }

    synchronized void clearNative() {
        prefs.edit().remove(K_NATIVE).remove(K_NATIVE_IV).remove(K_NATIVE_EXP).apply();
    }

    synchronized void clear() {
        prefs.edit().remove(K_TOKEN).remove(K_IV).remove(K_EMAIL)
                .remove(K_NATIVE).remove(K_NATIVE_IV).remove(K_NATIVE_EXP).apply();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
        } catch (Exception ignored) {}
    }

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            return (SecretKey) ks.getKey(ALIAS, null);
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }
}
