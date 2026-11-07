from backend.datasource import facts, normalise
from backend.judge import needs_russian, quote_matches, validate

CONV = normalise({
    "conversation_id": "t-1", "channel": "agent chat", "language": "RU", "audio_url": None,
    "transcript": [
        {"timestamp": "00:00", "speaker": "client", "text": "Где посмотреть мой тариф?"},
        {"timestamp": "00:05", "speaker": "system", "text": "Эскалация на оператора."},
        {"timestamp": "01:15", "speaker": "operator", "text": "Здравствуйте! Меня зовут Алина. Откройте «Кабинет»."},
        {"timestamp": "01:28", "speaker": "client", "text": "Нашла, спасибо."},
        {"timestamp": "02:04", "speaker": "operator", "text": "Пожалуйста. Хорошего вечера!"},
    ],
})
BIN = {"id": "c1", "type": "binary", "na_allowed": False, "gross": False, "scale": []}
BIN_NA = dict(BIN, id="c7", na_allowed=True)


def base(**kw):
    r = {"answer": "yes", "evidence": [], "checked_span": [], "expected_turn": -1, "na_reason": "",
         "explanation": "ok", "confidence": "high"}
    r.update(kw)
    return r


def test_valid_quote_passes():
    r, errs = validate(BIN, base(evidence=[{"turn": 2, "quote": "Меня зовут Алина"}]), CONV)
    assert errs == [] and r["evidence"][0]["speaker"] == "operator"


def test_wrong_turn_number_is_repointed():
    r, errs = validate(BIN, base(evidence=[{"turn": 1, "quote": "Меня зовут Алина"}]), CONV)
    assert errs == [] and r["evidence"][0]["turn"] == 2 and r["validator_notes"]


def test_invented_quote_rejected():
    _, errs = validate(BIN, base(evidence=[{"turn": 2, "quote": "Я ваш персональный менеджер"}]), CONV)
    assert any("not found" in e for e in errs)


def test_positive_needs_operator_evidence():
    _, errs = validate(BIN, base(evidence=[{"turn": 3, "quote": "Нашла, спасибо"}]), CONV)
    assert any("operator/system" in e for e in errs)


def test_no_needs_checked_span_with_expected_turn():
    _, errs = validate(BIN, base(answer="no"), CONV)
    assert any("checked_span" in e for e in errs)
    _, errs = validate(BIN, base(answer="no", checked_span=[2, 4], expected_turn=4), CONV)
    assert errs == []
    _, errs = validate(BIN, base(answer="no", checked_span=[2, 3], expected_turn=4), CONV)
    assert any("expected_turn" in e for e in errs)


def test_na_needs_reason_and_permission():
    _, errs = validate(BIN, base(answer="na"), CONV)
    assert any("not allowed" in e for e in errs)
    _, errs = validate(BIN_NA, base(answer="na"), CONV)
    assert any("na_reason" in e for e in errs)


def test_quote_matching_tolerates_punctuation_and_case():
    assert quote_matches("здравствуйте меня зовут алина", "Здравствуйте! Меня зовут Алина.")
    assert not quote_matches("совсем другое", "Здравствуйте! Меня зовут Алина.")


def test_facts_first_response():
    f = facts(CONV)
    assert f["first_operator_turn"] == 2 and f["first_response_sec"] == 70


def test_language_guard():
    assert needs_russian("Оператор сәлемдесті, бірақ өз атын атамады.")
    assert not needs_russian("Оператор поздоровался: «Сәлеметсіз бе, мен Дана».")
    assert needs_russian("The operator greeted the client and introduced themselves in the first reply.")
