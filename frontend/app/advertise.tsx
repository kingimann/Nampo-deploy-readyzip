import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image,
  ActivityIndicator, Modal, TextInput, Alert, KeyboardAvoidingView, Platform, Linking,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter, useLocalSearchParams } from "expo-router";
import { safeBack } from "@/src/utils/nav";
import * as ImagePicker from "@/src/platform/image-picker";
import { api, Post, AdCampaign, AdAccount, LinkAd, ReelAd, mediaUri } from "@/src/api/client";
import { stripeCardPay } from "@/src/lib/stripeEmbed";
import { uploadToCloudinary, cloudinaryEnabled } from "@/src/api/cloudinary";
import { useAuth } from "@/src/context/AuthContext";
import { theme } from "@/src/theme";

// Prototype ad pricing. Real billing will replace the fake checkout below;
// these numbers just drive the demo "Pay" amount.
const DURATIONS = [
  { days: 1, label: "1 day", price: 4.99 },
  { days: 7, label: "1 week", price: 19.99 },
  { days: 30, label: "1 month", price: 49.99 },
];

type Step = "duration" | "pay" | "done";

const formatCard = (t: string) =>
  t.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
const formatExp = (t: string) => {
  const d = t.replace(/\D/g, "").slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};

export default function AdvertiseScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  // Checkout flow state.
  const [picking, setPicking] = useState<Post | null>(null);
  const [step, setStep] = useState<Step>("duration");
  const [selDays, setSelDays] = useState<number>(7);
  const [busy, setBusy] = useState(false);
  const [payEnabled, setPayEnabled] = useState(false);
  useEffect(() => { api.getPaymentsConfig().then((c) => setPayEnabled(c.enabled)).catch(() => {}); }, []);
  const [result, setResult] = useState<Post | null>(null);
  const [campaigns, setCampaigns] = useState<Record<string, AdCampaign>>({});
  // Prepaid ad account.
  const [account, setAccount] = useState<AdAccount | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupAmount, setTopupAmount] = useState("25");
  const [topupBusy, setTopupBusy] = useState(false);
  const [topupMsg, setTopupMsg] = useState<string | null>(null);
  // Link ads (advertise your website).
  const [linkAds, setLinkAds] = useState<LinkAd[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [lUrl, setLUrl] = useState("");
  const [lHeadline, setLHeadline] = useState("");
  const [lDesc, setLDesc] = useState("");
  const [lDays, setLDays] = useState(7);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  // Pay-per-click campaign config (optional).
  const [ppc, setPpc] = useState(false);
  const [budget, setBudget] = useState("20");
  const [cpc, setCpc] = useState("0.25");
  // Reel video ads.
  const [reelAds, setReelAds] = useState<ReelAd[]>([]);
  const [reelOpen, setReelOpen] = useState(false);
  const [rVideo, setRVideo] = useState<string>("");
  const [rThumb, setRThumb] = useState<string | null>(null);
  const [rHeadline, setRHeadline] = useState("");
  const [rUrl, setRUrl] = useState("");
  const [rCta, setRCta] = useState("Learn more");
  const [rDuration, setRDuration] = useState(15);
  const [rDays, setRDays] = useState(7);
  const [rUploading, setRUploading] = useState(false);
  const [reelBusy, setReelBusy] = useState(false);
  const [reelMsg, setReelMsg] = useState<string | null>(null);

  // Prefilled demo card — this is a prototype, so we ship a working test card.
  const [card, setCard] = useState("4242 4242 4242 4242");
  const [exp, setExp] = useState("12/28");
  const [cvc, setCvc] = useState("123");
  const [name, setName] = useState(user?.name || "");

  const selected = DURATIONS.find((d) => d.days === selDays) ?? DURATIONS[1];

  const load = useCallback(async () => {
    if (!user) return;
    try { setPosts(await api.listUserPostsAll(user.user_id)); }
    catch {} finally { setLoading(false); }
    try {
      const { campaigns } = await api.getCampaigns();
      setCampaigns(Object.fromEntries(campaigns.map((c) => [c.post_id, c])));
    } catch {}
    try { setAccount(await api.getAdAccount()); } catch {}
    try { setLinkAds((await api.getLinkAds()).ads); } catch {}
    try { setReelAds((await api.getReelAds()).ads); } catch {}
  }, [user]);

  // Promote a reel passed via ?post= (from the reels screen).
  const { post: promotePostId } = useLocalSearchParams<{ post?: string }>();
  useEffect(() => {
    if (promotePostId && posts.length) {
      const p = posts.find((x) => x.id === promotePostId);
      if (p) openCheckout(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promotePostId, posts.length]);

  const pickReelVideo = async () => {
    if (rUploading) return;
    if (!cloudinaryEnabled()) { setReelMsg("Video uploads aren't configured on this server yet."); return; }
    if (Platform.OS !== "web") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["videos"] as any, quality: 0.7, videoMaxDuration: 60 });
    if (res.canceled || !res.assets?.[0]) return;
    setRUploading(true); setReelMsg(null);
    try {
      const up = await uploadToCloudinary(res.assets[0].uri, "video");
      setRVideo(up.url); setRThumb(up.thumbnail || null);
    } catch (e: any) { setReelMsg(String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setRUploading(false); }
  };

  const submitReelAd = async () => {
    if (!rVideo) { setReelMsg("Add a video for your ad."); return; }
    if (!rHeadline.trim()) { setReelMsg("Add a headline."); return; }
    if (rUrl.trim() && !/^https?:\/\//i.test(rUrl.trim())) { setReelMsg("Link must start with http(s)."); return; }
    setReelBusy(true); setReelMsg(null);
    try {
      await api.createReelAd({ video_url: rVideo, thumbnail: rThumb, headline: rHeadline.trim(), url: rUrl.trim() || undefined, cta: rCta, duration: rDuration, days: rDays });
      setReelOpen(false); setRVideo(""); setRThumb(null); setRHeadline(""); setRUrl("");
      await load();
    } catch (e: any) { setReelMsg(String(e?.message || e).replace(/^\d{3}:\s*/, "")); }
    finally { setReelBusy(false); }
  };
  const removeReelAd = async (id: string) => {
    setReelAds((arr) => arr.filter((a) => a.id !== id));
    try { await api.deleteReelAd(id); } catch { load(); }
  };

  const submitLinkAd = async () => {
    const url = lUrl.trim();
    if (!/^https?:\/\//i.test(url)) { setLinkMsg("Enter a valid http(s) link."); return; }
    if (!lHeadline.trim()) { setLinkMsg("Add a headline."); return; }
    setLinkBusy(true); setLinkMsg(null);
    try {
      await api.createLinkAd({ url, headline: lHeadline.trim(), description: lDesc.trim() || undefined, days: lDays });
      setLUrl(""); setLHeadline(""); setLDesc("");
      await load();
      setLinkOpen(false);
    } catch (e: any) {
      setLinkMsg(String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Couldn't create the link ad.");
    } finally { setLinkBusy(false); }
  };
  const removeLinkAd = async (id: string) => {
    setLinkAds((arr) => arr.filter((a) => a.id !== id));
    try { await api.deleteLinkAd(id); } catch { load(); }
  };
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openCheckout = (post: Post) => {
    setPicking(post);
    setSelDays(7);
    setResult(null);
    setStep("duration");
  };
  const closeCheckout = () => {
    if (busy) return;
    setPicking(null);
    setStep("duration");
    setResult(null);
  };

  const chooseDuration = (days: number) => {
    setSelDays(days);
    setStep("pay");
  };

  const campaignBudget = Math.max(1, Number(budget) || 0);
  const campaignCpc = Math.max(0.01, Number(cpc) || 0.25);
  const chargeAmount = ppc ? campaignBudget : selected.price;

  const pay = async () => {
    if (!picking) return;
    setBusy(true);
    try {
      const ppcOpts = ppc ? { budget: campaignBudget, cpc: campaignCpc } : undefined;
      // Real payments: hand off to Stripe Checkout; the webhook promotes the
      // post once payment confirms. Falls back to the test flow when off.
      if (payEnabled) {
        try {
          await stripeCardPay({
            kind: "promote", creator_id: "", amount: chargeAmount,
            extra: { post_id: picking.id, days: selDays, ...(ppc ? { budget: campaignBudget, cpc: campaignCpc } : {}) },
          });
          setBusy(false);
          return;
        } catch {}
      }
      // ── Test payment ────────────────────────────────────────────────
      await new Promise((r) => setTimeout(r, 1400));
      const updated = await api.promotePost(picking.id, selDays, ppcOpts);
      setPosts((arr) => arr.map((p) => (p.id === updated.id ? updated : p)));
      setResult(updated);
      setStep("done");
      load();
    } catch {
      Alert.alert("Payment failed", "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const doTopup = async () => {
    const amt = Number(topupAmount) || 0;
    if (amt <= 0) { setTopupMsg("Enter an amount to add."); return; }
    setTopupBusy(true);
    setTopupMsg(null);
    try {
      const res = await api.topupAdAccount(amt);
      if (res.stripe && res.url) {
        await Linking.openURL(res.url);
        setTopupBusy(false);
        return;
      }
      setTopupMsg(`Added $${amt.toFixed(2)} to your ad account.`);
      await load();
      setTimeout(() => { setTopupOpen(false); setTopupMsg(null); }, 1100);
    } catch (e: any) {
      setTopupMsg(String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Top-up failed.");
    } finally {
      setTopupBusy(false);
    }
  };

  const endsLabel = (iso?: string | null) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }); }
    catch { return ""; }
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="advertise-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack()} style={styles.iconBtn} testID="advertise-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Advertise</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30, gap: 12 }}
          ListHeaderComponent={
            <View style={{ gap: 12, marginBottom: 6 }}>
              {/* Prepaid ad account: keep campaigns running by loading a balance. */}
              <View style={styles.balanceCard}>
                <View style={styles.balanceTop}>
                  <View>
                    <Text style={styles.balanceLabel}>Ad account balance</Text>
                    <Text style={styles.balanceValue}>${(account?.balance ?? 0).toFixed(2)}</Text>
                  </View>
                  <TouchableOpacity style={styles.addFundsBtn} onPress={() => { setTopupMsg(null); setTopupOpen(true); }} testID="add-funds">
                    <Ionicons name="add" size={16} color="#fff" />
                    <Text style={styles.addFundsText}>Add funds</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.balanceSub}>
                  Your ads always show — funding is optional. When you add funds, usage is drawn as ads are seen: ${(account?.rates?.view ?? 0.01).toFixed(2)}/view · ${(account?.rates?.click ?? 0.10).toFixed(2)}/click · ${(account?.rates?.comment ?? 0.05).toFixed(2)}/comment.
                </Text>
                <Text style={styles.balanceMeta}>
                  {account?.active_campaigns ?? 0} active · ${(account?.lifetime_spend ?? 0).toFixed(2)} spent so far
                </Text>
              </View>

              {/* Link ads: advertise your website. */}
              <View style={styles.linkSection}>
                <View style={styles.linkHead}>
                  <Text style={styles.linkSectionTitle}>Advertise a link</Text>
                  <TouchableOpacity style={styles.linkNewBtn} onPress={() => { setLinkMsg(null); setLinkOpen(true); }} testID="new-link-ad">
                    <Ionicons name="add" size={15} color="#fff" />
                    <Text style={styles.linkNewText}>New</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.linkSectionSub}>Promote your website across OkaySpace and partner sites. Charged per view/click from your ad balance. Requires an account 60+ days old.</Text>
                {linkAds.map((a) => (
                  <View key={a.id} style={styles.linkRow}>
                    <Ionicons name="link" size={16} color={theme.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.linkRowTitle} numberOfLines={1}>{a.headline}</Text>
                      <Text style={styles.linkRowMeta} numberOfLines={1}>
                        {a.active ? "● Active" : "Ended"} · {a.impressions} views · {a.clicks} clicks · ${a.spent.toFixed(2)}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => removeLinkAd(a.id)} testID={`del-link-${a.id}`}>
                      <Ionicons name="trash-outline" size={16} color={theme.textMuted} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>

              {/* Reel video ads: sponsored full-screen videos in the reels feed. */}
              <View style={styles.linkSection}>
                <View style={styles.linkHead}>
                  <Text style={styles.linkSectionTitle}>Video reel ad</Text>
                  <TouchableOpacity style={styles.linkNewBtn} onPress={() => { setReelMsg(null); setReelOpen(true); }} testID="new-reel-ad">
                    <Ionicons name="add" size={15} color="#fff" />
                    <Text style={styles.linkNewText}>New</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.linkSectionSub}>A 5–60s video that plays full-screen in Reels with a "Sponsored" overlay and a call-to-action. Charged per view/click from your ad balance.</Text>
                {reelAds.map((a) => (
                  <View key={a.id} style={styles.linkRow}>
                    <Ionicons name="videocam" size={16} color={theme.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.linkRowTitle} numberOfLines={1}>{a.headline}</Text>
                      <Text style={styles.linkRowMeta} numberOfLines={1}>
                        {a.active ? "● Active" : "Ended"} · {a.duration}s · {a.impressions} views · {a.clicks} clicks · {(a.ctr ?? 0).toFixed(1)}% CTR · ${a.spent.toFixed(2)}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => removeReelAd(a.id)} testID={`del-reel-${a.id}`}>
                      <Ionicons name="trash-outline" size={16} color={theme.textMuted} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>

              <View style={styles.intro}>
                <Ionicons name="megaphone" size={20} color={theme.primary} />
                <Text style={styles.introText}>Promote a post to boost its reach. Funds are drawn from your ad account as people view, click and comment on your ads.</Text>
              </View>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="newspaper-outline" size={28} color={theme.textMuted} />
              <Text style={styles.emptyText}>Post something first, then promote it here.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const media = item.media?.[0];
            return (
              <View style={styles.row}>
                {media ? (
                  media.type === "video" ? (
                    <View style={[styles.thumb, styles.thumbVideo]}><Ionicons name="play" size={18} color="#fff" /></View>
                  ) : (
                    <Image source={{ uri: mediaUri(media) }} style={styles.thumb} resizeMode="cover" />
                  )
                ) : (
                  <View style={[styles.thumb, styles.thumbText]}><Ionicons name="text" size={18} color={theme.textMuted} /></View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText} numberOfLines={2}>{item.text || "(media post)"}</Text>
                  {item.promoted ? (
                    <Text style={styles.promotedNote}>● Promoted · ends {endsLabel(item.promoted_until)}</Text>
                  ) : (
                    <Text style={styles.rowMeta}>{item.likes_count} likes · {item.views_count || 0} views</Text>
                  )}
                  {campaigns[item.id] && (campaigns[item.id].impressions > 0 || campaigns[item.id].clicks > 0 || campaigns[item.id].budget > 0) && (
                    <Text style={styles.adStats}>
                      {campaigns[item.id].impressions.toLocaleString()} impressions · {campaigns[item.id].clicks} clicks · {campaigns[item.id].ctr}% CTR
                      {campaigns[item.id].budget > 0 ? ` · $${campaigns[item.id].spent.toFixed(2)}/$${campaigns[item.id].budget.toFixed(2)}` : ""}
                    </Text>
                  )}
                </View>
                <TouchableOpacity
                  style={[styles.promoteBtn, item.promoted && styles.promoteBtnActive]}
                  onPress={() => openCheckout(item)}
                  testID={`promote-${item.id}`}
                >
                  <Text style={[styles.promoteText, item.promoted && { color: theme.primary }]}>
                    {item.promoted ? "Extend" : "Promote"}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          }}
        />
      )}

      <Modal visible={!!picking} transparent animationType="slide" onRequestClose={closeCheckout}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.backdrop}
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={closeCheckout} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />

            {/* ── Step 1: pick a duration ─────────────────────────────── */}
            {step === "duration" && (
              <>
                <Text style={styles.sheetTitle}>Choose a package</Text>
                <Text style={styles.sheetSub}>How long should this post stay promoted?</Text>
                {DURATIONS.map((d) => (
                  <TouchableOpacity
                    key={d.days}
                    style={styles.durRow}
                    onPress={() => chooseDuration(d.days)}
                    testID={`promote-dur-${d.days}`}
                  >
                    <View>
                      <Text style={styles.durText}>{d.label}</Text>
                      <Text style={styles.durMeta}>Boosted reach for {d.label}</Text>
                    </View>
                    <View style={styles.durRight}>
                      <Text style={styles.durPrice}>${d.price.toFixed(2)}</Text>
                      <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
                    </View>
                  </TouchableOpacity>
                ))}
              </>
            )}

            {/* ── Step 2: fake checkout ───────────────────────────────── */}
            {step === "pay" && (
              <>
                <View style={styles.payHeader}>
                  <TouchableOpacity onPress={() => !busy && setStep("duration")} testID="pay-back">
                    <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
                  </TouchableOpacity>
                  <Text style={styles.sheetTitle}>Payment</Text>
                  <View style={{ width: 22 }} />
                </View>

                <View style={styles.testBanner}>
                  <Ionicons name="lock-closed" size={13} color={theme.primary} />
                  <Text style={styles.testBannerText}>{payEnabled ? "Secure checkout · powered by Stripe" : "Test mode · no real charge"}</Text>
                </View>

                <View style={styles.ppcRow}>
                  <TouchableOpacity style={[styles.ppcTab, !ppc && styles.ppcTabOn]} onPress={() => setPpc(false)} testID="camp-flat">
                    <Text style={[styles.ppcText, !ppc && { color: theme.primary }]}>Flat ({selected.label})</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.ppcTab, ppc && styles.ppcTabOn]} onPress={() => setPpc(true)} testID="camp-ppc">
                    <Text style={[styles.ppcText, ppc && { color: theme.primary }]}>Pay-per-click</Text>
                  </TouchableOpacity>
                </View>

                {ppc && (
                  <View style={styles.ppcInputs}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Budget ($)</Text>
                      <View style={styles.inputWrap}>
                        <TextInput style={styles.input} value={budget} onChangeText={(t) => setBudget(t.replace(/[^0-9.]/g, ""))} keyboardType="decimal-pad" testID="camp-budget" />
                      </View>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Cost / click ($)</Text>
                      <View style={styles.inputWrap}>
                        <TextInput style={styles.input} value={cpc} onChangeText={(t) => setCpc(t.replace(/[^0-9.]/g, ""))} keyboardType="decimal-pad" testID="camp-cpc" />
                      </View>
                    </View>
                  </View>
                )}

                <View style={styles.summary}>
                  <Text style={styles.summaryLabel}>{ppc ? `Pay-per-click · ~${Math.floor(campaignBudget / campaignCpc)} clicks` : `Promote · ${selected.label}`}</Text>
                  <Text style={styles.summaryPrice}>${chargeAmount.toFixed(2)}</Text>
                </View>

                {payEnabled ? (
                  <Text style={styles.stripeNote}>You'll be taken to Stripe's secure checkout to complete payment.</Text>
                ) : (
                  <>
                    <Text style={styles.fieldLabel}>Card number</Text>
                    <View style={styles.inputWrap}>
                      <Ionicons name="card-outline" size={18} color={theme.textMuted} />
                      <TextInput
                        style={styles.input}
                        value={card}
                        onChangeText={(t) => setCard(formatCard(t))}
                        keyboardType="number-pad"
                        placeholder="1234 5678 9012 3456"
                        placeholderTextColor={theme.textMuted}
                        maxLength={19}
                        editable={!busy}
                        testID="pay-card"
                      />
                    </View>

                    <View style={styles.fieldRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.fieldLabel}>Expiry</Text>
                        <View style={styles.inputWrap}>
                          <TextInput
                            style={styles.input}
                            value={exp}
                            onChangeText={(t) => setExp(formatExp(t))}
                            keyboardType="number-pad"
                            placeholder="MM/YY"
                            placeholderTextColor={theme.textMuted}
                            maxLength={5}
                            editable={!busy}
                            testID="pay-exp"
                          />
                        </View>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.fieldLabel}>CVC</Text>
                        <View style={styles.inputWrap}>
                          <TextInput
                            style={styles.input}
                            value={cvc}
                            onChangeText={(t) => setCvc(t.replace(/\D/g, "").slice(0, 4))}
                            keyboardType="number-pad"
                            placeholder="123"
                            placeholderTextColor={theme.textMuted}
                            maxLength={4}
                            editable={!busy}
                            testID="pay-cvc"
                          />
                        </View>
                      </View>
                    </View>

                    <Text style={styles.fieldLabel}>Name on card</Text>
                    <View style={styles.inputWrap}>
                      <TextInput
                        style={styles.input}
                        value={name}
                        onChangeText={setName}
                        placeholder="Full name"
                        placeholderTextColor={theme.textMuted}
                        editable={!busy}
                        testID="pay-name"
                      />
                    </View>
                  </>
                )}

                <TouchableOpacity
                  style={[styles.payBtn, busy && { opacity: 0.7 }]}
                  onPress={pay}
                  disabled={busy}
                  testID="pay-submit"
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.payBtnText}>{payEnabled ? `Continue · $${chargeAmount.toFixed(2)}` : `Pay $${chargeAmount.toFixed(2)}`}</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            {/* ── Step 3: success ─────────────────────────────────────── */}
            {step === "done" && (
              <View style={styles.doneWrap}>
                <View style={styles.doneCheck}>
                  <Ionicons name="checkmark" size={40} color="#fff" />
                </View>
                <Text style={styles.doneTitle}>Payment successful</Text>
                <Text style={styles.doneSub}>
                  Your post is promoted until {endsLabel(result?.promoted_until)}. It'll surface higher and show a "Sponsored" badge.
                </Text>
                <TouchableOpacity style={styles.payBtn} onPress={closeCheckout} testID="pay-done">
                  <Text style={styles.payBtnText}>Done</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Add funds to the ad account ─────────────────────────────── */}
      <Modal visible={topupOpen} transparent animationType="slide" onRequestClose={() => !topupBusy && setTopupOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => !topupBusy && setTopupOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Add funds</Text>
            <Text style={styles.sheetSub}>Load your ad account so your campaigns keep running.</Text>

            <View style={styles.presetRow}>
              {[10, 25, 50, 100].map((p) => {
                const on = Number(topupAmount) === p;
                return (
                  <TouchableOpacity key={p} style={[styles.preset, on && styles.presetOn]} onPress={() => setTopupAmount(String(p))} testID={`topup-${p}`}>
                    <Text style={[styles.presetText, on && { color: theme.primary }]}>${p}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.fieldLabel}>Amount ($)</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="wallet-outline" size={18} color={theme.textMuted} />
              <TextInput
                style={styles.input}
                value={topupAmount}
                onChangeText={(t) => setTopupAmount(t.replace(/[^0-9.]/g, ""))}
                keyboardType="decimal-pad"
                editable={!topupBusy}
                testID="topup-amount"
              />
            </View>

            {!account?.stripe_enabled && (
              <View style={styles.testBanner}>
                <Ionicons name="lock-closed" size={13} color={theme.primary} />
                <Text style={styles.testBannerText}>Test mode · funds added instantly, no real charge</Text>
              </View>
            )}
            {topupMsg && <Text style={styles.topupMsg}>{topupMsg}</Text>}

            <TouchableOpacity style={[styles.payBtn, topupBusy && { opacity: 0.7 }]} onPress={doTopup} disabled={topupBusy} testID="topup-submit">
              {topupBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.payBtnText}>Add ${(Number(topupAmount) || 0).toFixed(2)}</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Create a link ad ─────────────────────────────────────────── */}
      <Modal visible={linkOpen} transparent animationType="slide" onRequestClose={() => !linkBusy && setLinkOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => !linkBusy && setLinkOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Advertise a link</Text>
            <Text style={styles.sheetSub}>Your website shows as a sponsored card across OkaySpace and partner sites.</Text>

            <Text style={styles.fieldLabel}>Website URL</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="link" size={16} color={theme.textMuted} />
              <TextInput style={styles.input} value={lUrl} onChangeText={setLUrl} placeholder="https://example.com" placeholderTextColor={theme.textMuted} autoCapitalize="none" keyboardType="url" testID="link-url" />
            </View>
            <Text style={styles.fieldLabel}>Headline</Text>
            <View style={styles.inputWrap}>
              <TextInput style={styles.input} value={lHeadline} onChangeText={setLHeadline} placeholder="Visit my shop" placeholderTextColor={theme.textMuted} maxLength={120} testID="link-headline" />
            </View>
            <Text style={styles.fieldLabel}>Description (optional)</Text>
            <View style={styles.inputWrap}>
              <TextInput style={styles.input} value={lDesc} onChangeText={setLDesc} placeholder="A short line about it" placeholderTextColor={theme.textMuted} maxLength={300} testID="link-desc" />
            </View>

            <Text style={styles.fieldLabel}>Run for</Text>
            <View style={styles.ppcRow}>
              {[7, 14, 30].map((d) => (
                <TouchableOpacity key={d} style={[styles.ppcTab, lDays === d && styles.ppcTabOn]} onPress={() => setLDays(d)} testID={`link-days-${d}`}>
                  <Text style={[styles.ppcText, lDays === d && { color: theme.primary }]}>{d} days</Text>
                </TouchableOpacity>
              ))}
            </View>

            {linkMsg && <Text style={styles.topupMsg}>{linkMsg}</Text>}
            <TouchableOpacity style={[styles.payBtn, linkBusy && { opacity: 0.7 }]} onPress={submitLinkAd} disabled={linkBusy} testID="link-submit">
              {linkBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.payBtnText}>Launch link ad</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={reelOpen} transparent animationType="slide" onRequestClose={() => !reelBusy && setReelOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => !reelBusy && setReelOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Video reel ad</Text>
            <Text style={styles.sheetSub}>Plays full-screen in Reels with a Sponsored overlay and your call-to-action.</Text>

            <TouchableOpacity style={styles.reelVideoPick} onPress={pickReelVideo} disabled={rUploading} testID="reel-pick-video">
              {rUploading ? <ActivityIndicator color={theme.primary} /> : rVideo ? (
                <><Ionicons name="checkmark-circle" size={20} color={theme.primary} /><Text style={styles.reelVideoText}>Video added — tap to change</Text></>
              ) : (
                <><Ionicons name="cloud-upload-outline" size={20} color={theme.primary} /><Text style={styles.reelVideoText}>Upload a video (5–60s)</Text></>
              )}
            </TouchableOpacity>

            <Text style={styles.fieldLabel}>Headline</Text>
            <View style={styles.inputWrap}>
              <TextInput style={styles.input} value={rHeadline} onChangeText={setRHeadline} placeholder="Check out my new release" placeholderTextColor={theme.textMuted} maxLength={120} testID="reel-headline" />
            </View>
            <Text style={styles.fieldLabel}>Call-to-action link (optional)</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="link" size={16} color={theme.textMuted} />
              <TextInput style={styles.input} value={rUrl} onChangeText={setRUrl} placeholder="https://example.com" placeholderTextColor={theme.textMuted} autoCapitalize="none" keyboardType="url" testID="reel-url" />
            </View>

            <Text style={styles.fieldLabel}>Ad length</Text>
            <View style={styles.ppcRow}>
              {[5, 15, 30, 60].map((d) => (
                <TouchableOpacity key={d} style={[styles.ppcTab, rDuration === d && styles.ppcTabOn]} onPress={() => setRDuration(d)} testID={`reel-dur-${d}`}>
                  <Text style={[styles.ppcText, rDuration === d && { color: theme.primary }]}>{d}s</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.fieldLabel}>Run for</Text>
            <View style={styles.ppcRow}>
              {[7, 14, 30].map((d) => (
                <TouchableOpacity key={d} style={[styles.ppcTab, rDays === d && styles.ppcTabOn]} onPress={() => setRDays(d)} testID={`reel-days-${d}`}>
                  <Text style={[styles.ppcText, rDays === d && { color: theme.primary }]}>{d} days</Text>
                </TouchableOpacity>
              ))}
            </View>

            {reelMsg && <Text style={styles.topupMsg}>{reelMsg}</Text>}
            <TouchableOpacity style={[styles.payBtn, reelBusy && { opacity: 0.7 }]} onPress={submitReelAd} disabled={reelBusy} testID="reel-submit">
              {reelBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.payBtnText}>Launch reel ad</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: theme.textPrimary, fontSize: 18, fontWeight: "800", textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  intro: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 14, marginBottom: 6,
  },
  introText: { flex: 1, color: theme.textSecondary, fontSize: 13, lineHeight: 18 },
  linkSection: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14, gap: 4 },
  linkHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  linkSectionTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  linkSectionSub: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 4 },
  linkNewBtn: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: theme.primary, borderRadius: 999, paddingHorizontal: 12, height: 32 },
  linkNewText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  linkRowTitle: { color: theme.textPrimary, fontSize: 13.5, fontWeight: "700" },
  linkRowMeta: { color: theme.textMuted, fontSize: 11.5, marginTop: 2 },

  balanceCard: {
    backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border,
    padding: 16, gap: 8,
  },
  balanceTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  balanceLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  balanceValue: { color: theme.textPrimary, fontSize: 30, fontWeight: "900", marginTop: 2 },
  addFundsBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: theme.primary, borderRadius: 999, paddingHorizontal: 14, height: 38,
  },
  addFundsText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  balanceSub: { color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 },
  balanceMeta: { color: theme.textMuted, fontSize: 12 },

  presetRow: { flexDirection: "row", gap: 8, marginVertical: 10 },
  preset: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 12, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  presetOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  presetText: { color: theme.textSecondary, fontSize: 15, fontWeight: "800" },
  topupMsg: { color: theme.primary, fontSize: 13, fontWeight: "600", marginTop: 10, textAlign: "center" },
  empty: { alignItems: "center", paddingTop: 50, gap: 10 },
  emptyText: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingHorizontal: 40 },

  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    padding: 12,
  },
  thumb: { width: 52, height: 52, borderRadius: 10, backgroundColor: theme.surfaceAlt },
  thumbVideo: { alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  thumbText: { alignItems: "center", justifyContent: "center" },
  rowText: { color: theme.textPrimary, fontSize: 14, fontWeight: "600" },
  rowMeta: { color: theme.textMuted, fontSize: 12, marginTop: 3 },
  promotedNote: { color: theme.primary, fontSize: 12, fontWeight: "700", marginTop: 3 },
  adStats: { color: theme.textMuted, fontSize: 11.5, marginTop: 3 },
  ppcRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  ppcTab: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: "center", backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  ppcTabOn: { borderColor: theme.primary, backgroundColor: theme.surfaceAlt },
  ppcText: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  ppcInputs: { flexDirection: "row", gap: 12, marginBottom: 4 },
  promoteBtn: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 12,
    backgroundColor: theme.primary,
  },
  promoteBtnActive: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.primary },
  promoteText: { color: "#fff", fontSize: 13, fontWeight: "800" },

  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 12, paddingHorizontal: 18, borderTopWidth: 1, borderColor: theme.border,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, marginBottom: 14 },
  sheetTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  sheetSub: { color: theme.textMuted, fontSize: 13, marginTop: 2, marginBottom: 8 },

  durRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  durText: { color: theme.textPrimary, fontSize: 15, fontWeight: "700" },
  durMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  durRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  durPrice: { color: theme.primary, fontSize: 15, fontWeight: "800" },

  payHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: 12,
  },
  testBanner: {
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
    backgroundColor: theme.surfaceAlt, borderRadius: 8, borderWidth: 1, borderColor: theme.primary,
    paddingHorizontal: 10, paddingVertical: 5, marginBottom: 14,
  },
  testBannerText: { color: theme.primary, fontSize: 12, fontWeight: "700" },
  stripeNote: { color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginVertical: 6 },
  summary: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: theme.surfaceAlt, borderRadius: 12, padding: 14, marginBottom: 16,
  },
  summaryLabel: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  summaryPrice: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  fieldLabel: { color: theme.textMuted, fontSize: 12, fontWeight: "700", marginBottom: 6, marginTop: 4 },
  inputWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.bg, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 12, height: 48, marginBottom: 10,
  },
  input: { flex: 1, color: theme.textPrimary, fontSize: 15, height: "100%" },
  fieldRow: { flexDirection: "row", gap: 12 },
  reelVideoPick: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed", borderRadius: 12, height: 56, marginTop: 6, marginBottom: 4 },
  reelVideoText: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  payBtn: {
    backgroundColor: theme.primary, borderRadius: 14, height: 52,
    alignItems: "center", justifyContent: "center", marginTop: 10,
  },
  payBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },

  doneWrap: { alignItems: "center", paddingVertical: 10, gap: 8 },
  doneCheck: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: "#22C55E",
    alignItems: "center", justifyContent: "center", marginBottom: 6,
  },
  doneTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
  doneSub: { color: theme.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 19, paddingHorizontal: 10 },
});
