import React from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { theme } from "@/src/theme";

/** In-app confirmation dialog (replaces the browser's native window.confirm on web). */
export default function ConfirmModal({
  visible, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel",
  destructive, onConfirm, onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onCancel} />
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          {!!message && <Text style={styles.msg}>{message}</Text>}
          <View style={styles.row}>
            <TouchableOpacity style={[styles.btn, styles.cancel]} onPress={onCancel} testID="confirm-cancel">
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, destructive ? styles.destructive : styles.confirm]} onPress={onConfirm} testID="confirm-ok">
              <Text style={styles.confirmText}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 28 },
  card: { width: "100%", maxWidth: 360, backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.border, padding: 22 },
  title: { color: theme.textPrimary, fontSize: 18, fontWeight: "900" },
  msg: { color: theme.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 8 },
  row: { flexDirection: "row", gap: 10, marginTop: 20 },
  btn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: "center" },
  cancel: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  cancelText: { color: theme.textPrimary, fontWeight: "800", fontSize: 14.5 },
  confirm: { backgroundColor: theme.primary },
  destructive: { backgroundColor: theme.error },
  confirmText: { color: "#fff", fontWeight: "800", fontSize: 14.5 },
});
