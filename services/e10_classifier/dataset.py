"""Dataset: feature extraction and constants for the email classifier."""

import json
from pathlib import Path

import torch

# --- Label mapping (5 classes) ---
LABELS = ["ham", "spam", "marketing", "promotion", "trash"]
LABEL2ID = {l: i for i, l in enumerate(LABELS)}
ID2LABEL = {i: l for i, l in enumerate(LABELS)}

# --- 174 rspamd symbol names (sorted, fixed order for feature vector) ---
RSPAMD_SYMBOLS = [
    "ALIAS_RESOLVED", "ARC_NA", "ARC_REJECT", "AUTOGEN_PHP_SPAMMY",
    "BLACKLIST_DMARC", "BOUNCE", "BOUNCE_NO_AUTH", "CTYPE_MIXED_BOGUS",
    "CT_SURBL", "DATA_URI_OBFU", "DATE_IN_PAST", "DBL_SPAM", "DKIM_TRACE",
    "DMARC_BAD_POLICY", "DMARC_DNSFAIL", "DMARC_NA", "DMARC_POLICY_ALLOW",
    "DMARC_POLICY_ALLOW_WITH_FAILURES", "DMARC_POLICY_QUARANTINE",
    "DMARC_POLICY_REJECT", "DMARC_POLICY_SOFTFAIL", "DWL_DNSWL_NONE",
    "EMPTY_SUBJECT", "ENVFROM_PRVS", "EXT_CSS", "FAKE_REPLY",
    "FREEMAIL_ENVFROM", "FREEMAIL_ENVRCPT", "FREEMAIL_FROM", "FREEMAIL_MDN",
    "FREEMAIL_REPLYTO", "FREEMAIL_REPLYTO_NEQ_FROM", "FREEMAIL_TO",
    "FROM_DN_EQ_ADDR", "FROM_EQ_ENVFROM", "FROM_HAS_DN",
    "FROM_NAME_EXCESS_SPACE", "FROM_NEQ_ENVFROM", "FROM_NO_DN",
    "FUZZY_DENIED", "GOOGLE_FORWARDING_MID_MISSING", "GREYLIST",
    "HAS_ATTACHMENT", "HAS_DATA_URI", "HAS_LIST_UNSUB", "HAS_ORG_HEADER",
    "HAS_PHPMAILER_SIG", "HAS_REPLYTO", "HAS_XOIP", "HAS_X_ANTIABUSE",
    "HAS_X_AS", "HAS_X_GMSV", "HAS_X_PRIO_ONE", "HAS_X_SOURCE",
    "HEADER_CC_EMPTY_DELIMITER", "HEADER_FORGED_MDN",
    "HFILTER_FROMHOST_NORESOLVE_MX", "HFILTER_FROMHOST_NORES_A_OR_MX",
    "HFILTER_HOSTNAME_UNKNOWN", "HTML_SHORT_LINK_IMG_1",
    "HTML_SHORT_LINK_IMG_2", "HTTP_TO_HTTPS", "HTTP_TO_IP", "INTRODUCTION",
    "MANY_INVISIBLE_PARTS", "MICROSOFT_SPAM", "MID_CONTAINS_FROM",
    "MID_RHS_MATCH_FROM", "MID_RHS_MATCH_FROMTLD", "MID_RHS_NOT_FQDN",
    "MIME_BAD_ATTACHMENT", "MIME_BAD_EXTENSION", "MIME_BASE64_TEXT",
    "MIME_BASE64_TEXT_BOGUS", "MIME_GOOD", "MIME_HTML_ONLY",
    "MIME_MA_MISSING_TEXT", "MIME_TRACE", "MISSING_FROM", "MISSING_TO",
    "MISSING_XM_UA", "MSBL_EBL_FAIL", "ONCE_RECEIVED", "PHISHING",
    "PHISH_EMOTION", "PRECEDENCE_BULK", "PREVIOUSLY_DELIVERED",
    "RCPT_COUNT_FIVE", "RCPT_COUNT_ONE", "RCPT_COUNT_SEVEN",
    "RCPT_COUNT_THREE", "RCPT_COUNT_TWELVE", "RCPT_COUNT_TWO",
    "RCVD_COUNT_FIVE", "RCVD_COUNT_SEVEN", "RCVD_COUNT_THREE",
    "RCVD_COUNT_TWELVE", "RCVD_COUNT_TWO", "RCVD_COUNT_ZERO",
    "RCVD_IN_DNSWL_LOW", "RCVD_IN_DNSWL_MED", "RCVD_IN_DNSWL_NONE",
    "RCVD_NO_TLS_LAST", "RCVD_TLS_ALL", "RCVD_TLS_LAST",
    "RCVD_VIA_SMTP_AUTH", "RDNS_NONE", "RECEIVED_HELO_LOCALHOST",
    "RECEIVED_SPAMHAUS_CSS", "RECEIVED_SPAMHAUS_DROP",
    "RECEIVED_SPAMHAUS_PBL", "RECEIVED_SPAMHAUS_SBL",
    "RECEIVED_SPAMHAUS_XBL", "REDIRECTOR_FALSE", "REDIRECTOR_URL",
    "REPLYTO_ADDR_EQ_FROM", "REPLYTO_DN_EQ_FROM_DN",
    "REPLYTO_DOM_EQ_FROM_DOM", "REPLYTO_DOM_EQ_TO_DOM",
    "REPLYTO_DOM_NEQ_FROM_DOM", "REPLYTO_DOM_NEQ_TO_DOM",
    "REPLYTO_EQ_FROM", "RSPAMD_EMAILBL_FAIL", "RSPAMD_URIBL",
    "R_BAD_CTE_7BIT", "R_DKIM_ALLOW", "R_DKIM_NA", "R_DKIM_PERMFAIL",
    "R_DKIM_REJECT", "R_DKIM_TEMPFAIL", "R_EMPTY_IMAGE",
    "R_MISSING_CHARSET", "R_MIXED_CHARSET", "R_NO_SPACE_IN_FROM",
    "R_PARTS_DIFFER", "R_SPF_DNSFAIL", "R_SPF_FAIL", "R_SPF_NA",
    "R_SPF_NEUTRAL", "R_SPF_SOFTFAIL", "R_SUSPICIOUS_IMAGES",
    "R_UNDISC_RCPT", "SEM_URIBL_FRESH15", "SINGLE_SHORT_PART",
    "SPOOF_DISPLAY_NAME", "SUBJECT_ENDS_EXCLAIM", "SUBJECT_ENDS_QUESTION",
    "SUBJECT_ENDS_SPACES", "SUBJECT_HAS_EXCLAIM", "SUBJECT_HAS_QUESTION",
    "SUBJ_ALL_CAPS", "SUBJ_BOUNCE_WORDS", "SUBJ_EXCESS_BASE64",
    "SUBJ_EXCESS_QP", "SUSPICIOUS_AUTH_ORIGIN",
    "SUSPICIOUS_URL_IN_SUSPICIOUS_MESSAGE", "TAGGED_FROM", "TO_DN_ALL",
    "TO_DN_EQ_ADDR_ALL", "TO_DN_EQ_ADDR_SOME", "TO_DN_NONE", "TO_DN_SOME",
    "TO_DOM_EQ_FROM_DOM", "TO_EQ_FROM", "URIBL_BLACK", "URIBL_GREY",
    "URIBL_PBL", "URI_COUNT_ODD", "URL_MULTIPLE_AT_SIGNS",
    "URL_NUMERIC_PRIVATE_IP", "URL_USER_PASSWORD", "URL_VERY_LONG",
    "XM_UA_NO_VERSION", "ZERO_FONT",
]
SYMBOL2IDX = {s: i for i, s in enumerate(RSPAMD_SYMBOLS)}
NUM_SYMBOLS = len(RSPAMD_SYMBOLS)  # 174

# --- 7 threat categories (fixed order) ---
THREAT_CATEGORIES = [
    "1. BEC - Payment & Wire Fraud",
    "2. VEC & Supply Chain Attack",
    "3. Account Takeover (ATO)",
    "4. Social Engineering & Phishin",
    "5. Malware & Payload Delivery",
    "6. Evasion & Obfuscation",
    "8. Spam & Sender Reputation",
]
THREAT2IDX = {t: i for i, t in enumerate(THREAT_CATEGORIES)}
NUM_THREATS = len(THREAT_CATEGORIES)  # 7

# Number of numeric features: rspamd_score + received_hops + has_attachment = 3
NUM_NUMERIC = 3
NUM_FEATURES = NUM_SYMBOLS + NUM_NUMERIC  # 177


def extract_features(email: dict) -> torch.Tensor:
    """Extract 177-dim feature vector from an enriched email."""
    rspamd = email.get("rspamd", {})

    # Binary symbol flags (174)
    symbol_vec = [0.0] * NUM_SYMBOLS
    for sym in rspamd.get("fired_symbols", []):
        name = sym.get("name", "")
        if name in SYMBOL2IDX:
            symbol_vec[SYMBOL2IDX[name]] = 1.0

    # Numeric features (3)
    rspamd_score = rspamd.get("score", 0.0) / 15.0  # normalize to ~[0,1]
    received_hops = min(email.get("received_hops", 0), 20) / 20.0
    has_attachment = 1.0 if email.get("has_attachment", False) else 0.0

    features = symbol_vec + [rspamd_score, received_hops, has_attachment]
    return torch.tensor(features, dtype=torch.float32)


def extract_threat_scores(email: dict) -> torch.Tensor:
    """Extract 7-dim threat score vector."""
    rspamd = email.get("rspamd", {})
    cats = rspamd.get("attack_categories", {})
    scores = [0.0] * NUM_THREATS
    for cat, score in cats.items():
        if cat in THREAT2IDX:
            scores[THREAT2IDX[cat]] = score / 5.0  # normalize (most scores 0-5)
    return torch.tensor(scores, dtype=torch.float32)


def build_reason(email: dict) -> str:
    """Build a short reason string from rspamd fired symbols."""
    rspamd = email.get("rspamd", {})
    parts = []
    for sym in rspamd.get("fired_symbols", []):
        desc = sym.get("description", "")
        if desc and sym.get("score", 0) > 0:
            parts.append(desc)
    if not parts:
        label = email.get("label", "unknown")
        return f"Classified as {label} based on content analysis"
    return " + ".join(parts[:4])
