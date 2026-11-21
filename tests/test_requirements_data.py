"""Checks on the generated requirements dataset (data/requirements, data/courses.json).

These run offline against the committed files. They cover the contract in docs/data-contracts.md
(every rule well-formed, every referenced course and group present) plus a handful of facts read by
hand off the 2026-27 catalog pages, so a bad scrape or converter change shows up as a failure.
"""
import glob
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import build_requirements as br  # noqa: E402

REQ = os.path.join(ROOT, "data", "requirements")


def load(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def courses():
    return {c["id"]: c for c in load("data", "courses.json")}


@pytest.fixture(scope="module")
def groups():
    return {os.path.basename(f)[:-5]: load(f) for f in glob.glob(os.path.join(REQ, "groups", "*.json"))}


@pytest.fixture(scope="module")
def majors():
    return load("data", "requirements", "majors.json")


def course_ids(rule):
    if rule["type"] == "course":
        yield rule["course"]
    for c in rule.get("filter", {}).get("courses", []):
        yield c
    for r in rule.get("rules", []):
        yield from course_ids(r)


def req(group, rid):
    return next(q for q in group["requirements"] if q["id"] == rid)


# ---- contract

def test_every_group_is_valid(groups, courses):
    errors = []
    for gid, g in groups.items():
        assert g["id"] == gid
        br.validate_group(g, courses, errors)
    assert not errors, errors[:20]


def test_course_records(courses):
    assert len(courses) > 5000
    for c in courses.values():
        assert c["id"] == f"{c['subject']} {c['number']}"
        assert set(c["breadths"]) <= set(br.BREADTHS)
        assert set(c["attributes"]) <= br.ATTRS
        assert c["title"]
    for other in (x for c in courses.values() for x in c.get("crossListed", [])):
        assert other in courses


def test_majors_point_at_existing_groups(majors, groups):
    ids = [m["id"] for m in majors]
    assert len(ids) == len(set(ids))
    for m in majors:
        assert m["college"] in br.COLLEGES
        for gid in m["requirementGroupIds"] + [m["collegeGroupId"], m["universityGroupId"]]:
            assert gid in groups, (m["id"], gid)
        assert groups[m["requirementGroupIds"][0]]["kind"] == "major"
        assert groups[m["collegeGroupId"]]["kind"] == "college"


def test_colleges_and_minors(groups):
    colleges = load("data", "requirements", "colleges.json")
    assert {c["id"] for c in colleges} == {"LS", "CDSS", "COE", "HAAS", "CED", "CNR", "CHEM", "BSE"}
    for c in colleges:
        assert c["requirementGroupId"] in groups
    minors = load("data", "requirements", "minors.json")
    assert len(minors) > 100
    for m in minors:
        assert groups[m["requirementGroupIds"][0]]["kind"] == "minor"


def test_subject_aliases(courses):
    subjects = {s["code"]: s for s in load("data", "subjects.json")}
    assert "EL ENG" in subjects["ELENG"]["aliases"]
    assert "CS" in subjects["COMPSCI"]["aliases"]
    assert {c["subject"] for c in courses.values()} == set(subjects)


# ---- facts checked by hand against the 2026-27 catalog

def test_major_counts(majors):
    by = {}
    for m in majors:
        by[m["college"]] = by.get(m["college"], 0) + 1
    assert len(majors) >= 110
    assert by["LS"] >= 60 and by["COE"] >= 20 and by["CDSS"] == 3 and by["CED"] == 4 and by["HAAS"] == 1
    names = {m["name"] for m in majors}
    for n in ("Computer Science", "Data Science", "Statistics", "Economics", "Electrical Engineering and Computer Sciences",
              "Business Administration", "Molecular and Cell Biology", "Psychology", "Mechanical Engineering", "Architecture"):
        assert n in names, n


def test_computer_science_lower_division(groups):
    g = groups["major-computer-science-ba"]
    math = req(g, "mathematics")["rule"]
    assert math["type"] == "allOf"
    assert {"MATH 51", "MATH 52"} <= {r.get("course") for r in math["rules"]}
    linalg = next(r for r in math["rules"] if r["type"] == "anyOf")
    assert {"MATH 54", "MATH 56", "ELENG 16A"} <= set(course_ids(linalg))
    cs = req(g, "computer-science")["rule"]
    assert cs["type"] == "filter" and cs["count"] == 4
    assert {"COMPSCI 61A", "COMPSCI 61B", "COMPSCI 61C", "COMPSCI 70"} <= set(cs["filter"]["courses"])
    # college and university rules live in their own groups, not in the major
    assert not any("Breadth" in q["title"] or "American Cultures" in q["title"] for q in g["requirements"])


def test_university_group(groups):
    titles = {q["title"] for q in groups["university"]["requirements"]}
    assert {"American Cultures", "American History and Institutions", "Entry Level Writing (ELWR)", "Minimum Total Units"} <= titles
    ac = next(q for q in groups["university"]["requirements"] if q["title"] == "American Cultures")["rule"]
    assert ac == {"type": "filter", "count": 1, "filter": {"attribute": "AC"}}
    units = next(q for q in groups["university"]["requirements"] if q["title"] == "Minimum Total Units")["rule"]
    assert units["type"] == "units" and units["minUnits"] == 120


@pytest.mark.parametrize("gid", ["college-LS", "college-CDSS", "college-HAAS", "college-CED"])
def test_seven_course_breadth(groups, gid):
    breadth = next(q for q in groups[gid]["requirements"] if "Breadth" in q["title"])["rule"]
    assert [r["filter"]["breadth"] for r in breadth["rules"]] == br.BREADTHS


def test_colleges_differ(groups):
    ls = {q["title"] for q in groups["college-LS"]["requirements"]}
    coe = {q["title"] for q in groups["college-COE"]["requirements"]}
    assert "L&S Language Requirement" in ls and "L&S Quantitative Reasoning" in ls
    assert "COE Humanities and Social Sciences Requirement" in coe and not any("Seven" in t for t in coe)
    assert any("Computational Reasoning" in q["title"] for q in groups["college-CDSS"]["requirements"])


def test_course_tags(courses):
    assert "AC" in courses["AFRICAM 27AC"]["attributes"]
    assert "RCA" in courses["COLWRIT R1A"]["attributes"]
    assert "RCB" in courses["COLWRIT R4B"]["attributes"]
    assert "UD" in courses["COMPSCI 162"]["attributes"] and "UD" not in courses["COMPSCI 61A"]["attributes"]
    assert courses["COMPSCI 61A"]["units"] == 4
    assert sum(1 for c in courses.values() if c["breadths"]) > 2000
    for area in br.BREADTHS:
        assert sum(1 for c in courses.values() if area in c["breadths"]) > 100, area
    assert sum(1 for c in courses.values() if "AC" in c["attributes"]) > 200


# ---- converter unit tests (no data files needed)

class FakeBuilder(br.Builder):
    def __init__(self):  # skip loading the snapshot
        self.gid2id = {"1": "MATH 51", "2": "MATH 52", "3": "MATH 54", "4": "MATH 56", "5": "STAT 20"}
        self.courses = {v: {"id": v} for v in self.gid2id.values()}
        self.csets = {"S": {"courses": ["1", "2", "5", "999"]}}
        self.sets, self.warnings, self.used_courses = {}, [], set()
        import collections
        self.unresolved = collections.Counter()
        self.stats, self.fatal = collections.defaultdict(list), []
        self.subjects, self.alias = ["MATH", "STAT"], {}
        import re
        self.mention_re = re.compile(r"(?<![A-Za-z])(MATH|STAT)\s+([A-Z]{0,2}\d{1,3}[A-Z]{0,3})\b")
        self.more_re = re.compile(r"\s*(?:,|/|,?\s+or|,?\s+and|&)\s*([A-Z]{0,2}\d{1,3}[A-Z]{0,3})\b(?!\s+units?)")


def groups_of(*gs):
    return {"condition": "courses", "values": [{"value": list(ids), "logic": logic} for ids, logic in gs]}


def test_convert_all_of_with_alternatives():
    b = FakeBuilder()
    rule, _ = b.convert_rule({"condition": "completedAllOf", "value": groups_of((["1"], "and"), (["3", "4"], "or"))}, "t")
    assert rule == {"type": "allOf", "rules": [{"type": "course", "course": "MATH 51"},
                                               {"type": "anyOf", "rules": [{"type": "course", "course": "MATH 54"}, {"type": "course", "course": "MATH 56"}]}]}


def test_convert_at_least_n():
    b = FakeBuilder()
    v = groups_of((["1"], "and"), (["2"], "and"), (["3"], "and"))
    rule, _ = b.convert_rule({"condition": "completedAtLeastXOf", "restriction": 2, "value": v}, "t")
    assert rule == {"type": "filter", "count": 2, "filter": {"courses": ["MATH 51", "MATH 52", "MATH 54"]}}
    rule, _ = b.convert_rule({"condition": "completedAtLeastXOf", "restriction": 1, "value": v}, "t")
    assert rule["type"] == "anyOf" and len(rule["rules"]) == 3
    mixed = groups_of((["1"], "and"), (["3", "4"], "or"), (["5"], "and"))
    rule, _ = b.convert_rule({"condition": "completedAtLeastXOf", "restriction": 2, "value": mixed}, "t")
    assert rule["type"] == "nOf" and rule["n"] == 2


def test_convert_pick_n_from_one_list():
    b = FakeBuilder()
    rule, _ = b.convert_rule({"condition": "completedAtLeastXOf", "restriction": 2, "value": groups_of((["1", "2", "3"], "or"))}, "t")
    assert rule == {"type": "filter", "count": 2, "filter": {"courses": ["MATH 51", "MATH 52", "MATH 54"]}}


def test_convert_units_course_set_and_retired_course():
    b = FakeBuilder()
    v = {"condition": "courseSets", "values": [{"value": ["S"], "logic": "and"}]}
    rule, _ = b.convert_rule({"condition": "minimumCredits", "credits": 8, "value": v}, "t")
    assert rule == {"type": "filter", "minUnits": 8, "filter": {"courses": ["MATH 51", "MATH 52", "STAT 20"]}}  # 999 dropped


def test_convert_free_text_becomes_self_check_with_mentions():
    b = FakeBuilder()
    rule, _ = b.convert_rule({"condition": "freeformText", "description": "<p>Take MATH 51, 52 or 54 and STAT 20 (4 units).</p>"}, "t")
    assert rule["type"] == "manual"
    assert rule["mentionedCourses"] == ["MATH 51", "MATH 52", "MATH 54", "STAT 20"]


def test_text_of_html():
    assert br.text_of("<p>A&amp;B</p><ul><li><p>one</p></li><li>two</li></ul>") == "A&B\n- one\n- two"


# ---- generated rules agree with what the catalog pages show

def test_rules_match_rendered_catalog_pages(groups):
    """Every program's Requirements tab was saved as text; nearly every course line on it must be in our rules."""
    programs = br.load(os.path.join(br.RAW, "programs.json.gz"))
    by_code = {g.get("catalogCode"): g for g in groups.values() if g.get("catalogCode")}
    shown, missing, _extra, _detail = br.crosscheck(programs, by_code)
    assert shown > 12000
    assert missing / shown < 0.005


def test_build_is_reproducible_from_snapshot(groups):
    """Rebuilding from data/raw/catalog gives exactly the committed files."""
    import subprocess
    before = {gid: json.dumps(g, sort_keys=True) for gid, g in groups.items()}
    subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "build_requirements.py"), "--strict"], check=True, capture_output=True)
    after = {os.path.basename(f)[:-5]: json.dumps(load(f), sort_keys=True) for f in glob.glob(os.path.join(REQ, "groups", "*.json"))}
    assert before == after


def test_computer_science_override_applied(groups):
    design = req(groups["major-computer-science-ba"], "design")
    assert design.get("overridden") and "COMPSCI 162" in set(course_ids(design["rule"]))


# ---- course coverage

def test_popular_courses_exist(courses):
    for cid in ["ENGLISH R1A", "ENGLISH R1B", "DATA C100", "COMPSCI 61A", "COLWRIT R1A", "AFRICAM R1B", "ART 171", "HISTART 90"]:
        assert cid in courses, cid
    assert "RCA" in courses["ENGLISH R1A"]["attributes"] and "RCB" in courses["ENGLISH R1B"]["attributes"]


def test_every_catalog_course_is_in_the_snapshot(courses):
    """data/raw/catalog/course_index.json.gz is the catalog's own CSV export of its course list."""
    index = br.load(os.path.join(br.RAW, "course_index.json.gz"))
    assert len(index) > 6500
    assert not sorted(set(index) - set(courses))


def test_predicted_undergraduate_courses_exist(courses):
    """The planner joins predictions to courses.json by id; a course missing here silently loses its page."""
    pred = {p["course"] for p in load("data", "predictions", "predictions.json")["predictions"]}
    undergrad = {c for c in pred if int("".join(ch for ch in c.rsplit(" ", 1)[-1] if ch.isdigit()) or 0) < 200}
    assert not sorted(undergrad - set(courses))


def test_supplement_courses_are_marked(courses):
    extra = [c for c in courses.values() if c.get("source")]
    index = set(br.load(os.path.join(br.RAW, "course_index.json.gz")))
    for c in extra:
        assert c["source"] == "berkeleytime" and c["id"] not in index and c["title"], c["id"]


def test_cross_listing_is_symmetric_and_complete(courses, groups):
    for c in courses.values():
        family = set(c.get("crossListed", [])) | {c["id"]}
        assert c["id"] not in c.get("crossListed", [])
        for other in c.get("crossListed", []):
            assert other in courses, (c["id"], other)
            assert set(courses[other].get("crossListed", [])) | {other} == family, (c["id"], other)
    assert set(courses["DATA C8"]["crossListed"]) >= {"COMPSCI C8", "INFO C8", "STAT C8"}
    # rules keep naming every member of a family
    ds = req(groups["major-data-science-ba"], "data-science")
    assert {"DATA C8", "COMPSCI C8", "INFO C8", "STAT C8"} <= set(course_ids(ds["rule"]))


# ---- choices (concentrations, emphases, tracks)

def test_choices_are_consistent(groups):
    with_choice = {gid: g for gid, g in groups.items() if g.get("choices")}
    assert len(with_choice) >= 25
    for gid, g in with_choice.items():
        declared = {(c["id"], o["id"]) for c in g["choices"] for o in c["options"]}
        used = {(q["choice"], q["option"]) for q in g["requirements"] if "choice" in q}
        assert used <= declared, gid
        spec = br.load(br.CHOICES_FILE)["programs"][gid]
        empty_ok = {br.slug(o["title"]) for c in spec["choices"] for o in c.get("options", []) if o.get("empty")}
        assert {o for _, o in declared - used} <= empty_ok, (gid, declared - used)
        assert any("choice" not in q for q in g["requirements"]) or gid in ("major-scandinavian-ba", "major-spanish-and-portuguese-ba", "major-slavic-languages-and-literatures-ba", "major-middle-eastern-languages-and-cultures-ba"), gid


def test_data_science_domain_emphasis(groups):
    g = groups["major-data-science-ba"]
    (choice,) = g["choices"]
    assert (choice["id"], choice["title"], choice["pick"]) == ("domain-emphasis", "Domain Emphasis", 1)
    titles = [o["title"] for o in choice["options"]]
    assert len(titles) == 28 and titles[0] == "Aerospace" and "Cognition" in titles and titles[-1] == "Urban Science"
    cognition = [q for q in g["requirements"] if q.get("option") == "cognition"]
    assert [(q["id"], q["title"], q["section"]) for q in cognition] == [
        ("cognition-lower-division", "Lower Division", "Cognition"), ("cognition-upper-division", "Upper Division", "Cognition")]
    common = [q["id"] for q in g["requirements"] if "choice" not in q]
    assert common == ["data-science", "calculus-part-1", "calculus-part-2", "linear-algebra", "program-structures", "data-structures",
                      "principles-of-data-science", "computational-and-inferential-depth", "probability",
                      "modeling-learning-and-decision-making", "human-contexts-and-ethics"]
    sde = [q["title"] for q in g["requirements"] if q.get("option") == "sustainable-development-and-engineering"]
    assert sde == ["Lower Division", "Upper Division"]


def test_mcb_emphasis_and_tracks_are_one_choice(groups):
    g = groups["major-molecular-and-cell-biology-ba"]
    (choice,) = g["choices"]
    titles = [o["title"] for o in choice["options"]]
    assert len(titles) == 12 and "Biochemistry, Biophysics & Structural Biology: Track 2" in titles and titles[-1] == "Neurobiology"
    assert {q["section"] for q in g["requirements"] if "choice" not in q} == {"Lower Division"}


def test_shared_blocks_are_repeated_per_option(groups):
    g = groups["major-life-science-business-and-entrepreneurship-ba-bs"]
    (choice,) = g["choices"]
    assert len(choice["options"]) == 15
    opt = "molecular-and-cell-biology-neurobiology"
    sections = [q["section"] for q in g["requirements"] if q.get("option") == opt]
    assert set(sections) == {"Molecular and Cell Biology: Neurobiology: Lower Division", "Molecular and Cell Biology: Neurobiology: Upper Division"}


# ---- alternatives merged into one requirement

def test_option_rows_are_merged(groups):
    la = req(groups["major-data-science-ba"], "linear-algebra")
    assert la["title"] == "Linear Algebra" and la["rule"]["type"] == "anyOf"
    assert [r["label"] for r in la["rule"]["rules"]] == ["Option 1", "Option 2"]
    assert {"MATH 54", "ELENG 66", "ELENG 64"} <= set(course_ids(la["rule"]))
    assert la["rule"]["rules"][1]["type"] == "allOf"
    for gid, g in groups.items():
        for q in g["requirements"]:
            assert not br.OPTION_SUFFIX.match(q["title"]) or q["title"].count("Option ") != 1, (gid, q["title"])
    physics = req(groups["major-engineering-physics-bs"], "physics")
    assert physics["rule"]["type"] == "anyOf" and len(physics["rule"]["rules"]) == 2
    bins = req(groups["major-linguistics-ba"], "upper-division-bins")
    assert bins["rule"]["type"] == "nOf" and bins["rule"]["n"] == 4 and len(bins["rule"]["rules"]) == 5


# ---- tidy titles and sections

def test_titles_and_sections_are_tidy(groups):
    for gid, g in groups.items():
        for q in g["requirements"]:
            for key in ("title", "section"):
                v = q.get(key)
                assert v is None or (v == " ".join(v.split()) and not v.endswith(":")), (gid, q["id"], v)
            assert q.get("section") not in ("Upper-Division Requirements", "Upper Division Requirements", "Lower Division Requirements")
    cog = groups["major-cognitive-science-ba"]
    sections = {q["title"]: q["section"] for q in cog["requirements"]}
    assert sections["Cognitive Psychology"] == sections["Electives"] == sections["Cognitive Neuroscience"] == "Upper Division"


# ---- prose lists

def test_cognitive_science_electives_is_a_real_rule(groups):
    q = req(groups["major-cognitive-science-ba"], "electives")
    assert q["rule"]["type"] == "filter" and q["rule"]["count"] == 3 and len(q["rule"]["filter"]["courses"]) > 150
    assert len(q.get("notes", "")) < 300


def test_notes_do_not_repeat_long_lists(groups):
    for gid, g in groups.items():
        if g["kind"] in ("major", "minor"):
            for q in g["requirements"]:
                assert (q.get("notes") or "").count("\n- ") < 40, (gid, q["id"])


def test_convert_prose_course_list():
    b = FakeBuilder()
    body = "<p>Each with a letter grade.</p><p>Complete at least 2 of:</p><ul><li>MATH 51</li><li>MATH 52</li><li>STAT 20</li><li>MATH 999</li></ul>"
    rule, notes = b.convert_rule({"condition": "freeformText", "description": body}, "t")
    assert rule == {"type": "filter", "count": 2, "filter": {"courses": ["MATH 51", "MATH 52", "STAT 20"]}}
    assert notes == "Each with a letter grade."
    rule, _ = b.convert_rule({"condition": "freeformText", "description": "<p>Complete at least 8 units of:</p><ul><li>MATH 51</li><li>MATH 52</li></ul>"}, "t")
    assert rule == {"type": "filter", "minUnits": 8, "filter": {"courses": ["MATH 51", "MATH 52"]}}
    rule, notes = b.convert_rule({"condition": "freeformText", "description": "<p>Complete at least 3 of:</p><ul><li>Any 3+ unit MATH 100-196 level course (excluding MATH 51)</li></ul>"}, "t")
    assert rule == {"type": "filter", "count": 3, "filter": {"subjects": ["MATH"], "minNumber": 100, "maxNumber": 196, "exclude": ["MATH 51"]}}
    assert "at least 3 units" in notes
    rule, _ = b.convert_rule({"condition": "freeformText", "description": "<p>Complete at least 2 of:</p><ul><li>MATH 51</li><li>Any course approved by the advisor</li></ul>"}, "t")
    assert rule["type"] == "manual"


def test_exam_notes_get_a_lead_in():
    assert br.exam_lead_in("- AP: Statistics, score 3+\n- ALEVEL: Mathematics, score 1-2") == "Also satisfied by:\n- AP: Statistics, score 3+\n- A-Level: Mathematics, score 1-2"
    assert br.exam_lead_in("C- or better.\nAP: World History, score 5+") == "C- or better.\nAlso satisfied by:\n- AP: World History, score 5+"
    assert br.exam_lead_in("Calculus 1 exams:\n- AP: Calculus AB, score 3+").startswith("Calculus 1 exams:\n- AP")


# ---- aliases

def test_program_aliases(majors):
    by_name = {(m["name"], m.get("degree")): m for m in majors}
    want = {("Cognitive Science", "BA"): "cogsci", ("Data Science", "BA"): "ds", ("Computer Science", "BA"): "cs",
            ("Electrical Engineering and Computer Sciences", "BS"): "eecs", ("Molecular and Cell Biology", "BA"): "mcb",
            ("Political Science", "BA"): "poli sci", ("Economics", "BA"): "econ", ("Business Administration", "BS"): "haas",
            ("Mechanical Engineering", "BS"): "meche", ("Industrial Engineering and Operations Research", "BS"): "ieor"}
    for key, alias in want.items():
        assert alias in by_name[key]["aliases"], key
    for m in majors + load("data", "requirements", "minors.json"):
        assert isinstance(m["aliases"], list) and all(a == a.lower() and a for a in m["aliases"]), m["name"]
    assert "compsci" in by_name[("Computer Science", "BA")]["aliases"] or "eleng" in by_name[("Computer Science", "BA")]["aliases"]


# ---- second QA round: same class under another number, popularity, optional rows, wider lists

def test_same_as_links_renumbered_classes(courses):
    want = {"MATH 1A": {"MATH 51"}, "MATH 1B": {"MATH 52"}, "EECS 16A": {"ELENG 16A", "ELENG 66"}, "EECS 16B": {"ELENG 16B", "ELENG 64"},
            "STAT 88": {"STAT C88S", "DATA C88S"}, "UGBA 10": {"UGBA 10X"}, "ELENG 126": {"EECS 126"}}
    for cid, others in want.items():
        assert set(courses[cid].get("sameAs", [])) | set(courses[cid].get("crossListed", [])) >= others, cid
    assert "SOCIOL 102" not in courses["SOCIOL 103"].get("sameAs", [])  # 102 now belongs to a different class
    assert courses["EECS 16A"]["title"] == "Designing Information Devices and Systems I"


def test_same_as_is_symmetric_closed_and_apart_from_cross_listing(courses):
    for cid, c in courses.items():
        same, cross = c.get("sameAs", []), c.get("crossListed", [])
        assert cid not in same and not set(same) & set(cross), cid
        family = {cid, *same, *cross}
        for o in same:
            assert o in courses, (cid, o)
            assert cid in courses[o]["sameAs"], (cid, o)
            assert {o, *courses[o].get("sameAs", []), *courses[o].get("crossListed", [])} == family, (cid, o)
    retired = [c for c in courses.values() if c.get("retired")]
    assert len(retired) > 100 and all(c.get("sameAs") and c["title"] for c in retired)


def test_popularity(courses):
    assert all(isinstance(c["popularity"], int) and c["popularity"] >= 0 for c in courses.values())
    assert courses["ENGLISH R1A"]["popularity"] > courses["AFRICAM R1A"]["popularity"] > 0
    assert courses["MATH 1A"]["popularity"] == courses["MATH 51"]["popularity"] > 5000


def test_optional_blocks_are_flagged(groups):
    g = groups["major-applied-mathematics-ba"]
    assert {q["title"] for q in g["requirements"] if q.get("optional")} == {"Thesis", "Graduate Level Math Courses"}
    for g in groups.values():
        assert all(q.get("optional") in (None, True) for q in g["requirements"])


def test_entry_level_writing_can_be_ticked_by_a_class(groups, courses):
    rule = req(groups["university"], "entry-level-writing-elwr")["rule"]
    attrs = {r["filter"]["attribute"] for r in rule["rules"] if r["type"] == "filter"}
    assert rule["type"] == "anyOf" and attrs == {"ELW", "RCA"} and rule["rules"][-1]["type"] == "manual"


def test_minimum_units_is_stated_once(groups):
    assert req(groups["university"], "minimum-total-units")["rule"]["minUnits"] == 120
    for gid, g in groups.items():
        if g["kind"] == "college":
            assert not any(q["rule"] == {"type": "units", "minUnits": 120, "filter": {}} for q in g["requirements"]), gid
            assert len(g["title"]) < 90, g["title"]


def test_lists_widened_by_a_number_range(groups):
    econ = set(course_ids(req(groups["major-economics-ba"], "electives")["rule"]))
    assert {"ECON 121", "ECON 157", "UGBA 131"} <= econ and not econ & {"ECON 100A", "ECON 101B", "ECON 140", "ECON 141", "ECON H195A"}
    assert "LINGUIS 111" in set(course_ids(req(groups["major-linguistics-ba"], "electives")["rule"]))
    math = req(groups["major-mathematics-ba"], "mathematics-no-concentration-electives")["rule"]
    assert math["type"] != "manual" and len(set(course_ids(math))) > 50


def test_statistics_cluster_is_a_course_list(groups):
    g = groups["major-statistics-ba"]
    cluster = [q for q in g["requirements"] if q["section"] == "Cluster Courses"]
    assert len(cluster) == 1 and cluster[0]["rule"]["type"] == "filter" and cluster[0]["rule"]["count"] == 3
    ids = set(course_ids(cluster[0]["rule"]))
    assert {"ANTHRO 127A", "ECON 141", "DATA 101", "UGBA 103"} <= ids and "COMPSCI C100" not in ids


def test_engineering_physics_and_business_overrides(groups):
    g = groups["major-engineering-physics-bs"]
    physics = req(g, "physics")["rule"]
    assert [sorted(course_ids(r)) for r in physics["rules"]] == [["PHYSICS 7A", "PHYSICS 7B", "PHYSICS 7C"],
                                                               ["PHYSICS 5A", "PHYSICS 5B", "PHYSICS 5BL", "PHYSICS 5C", "PHYSICS 5CL"]]
    assert set(course_ids(req(g, "chemistry")["rule"])) == {"CHEM 1A", "CHEM 1AL", "CHEM 4A"}
    te = list(course_ids(req(g, "technical-electives")["rule"]))
    assert te.count("CHEM 3AL") == 1 and "CHEM 3A" in te
    assert set(course_ids(req(groups["major-business-administration-bs"], "business-principles")["rule"])) == {"UGBA 10", "UGBA 10X"}


def test_no_course_is_listed_twice_in_one_list(groups):
    def walk(rule):
        subs = rule.get("rules", [])
        keys = [json.dumps({k: v for k, v in r.items() if k != "label"}, sort_keys=True) for r in subs]
        assert len(keys) == len(set(keys)), rule
        for r in subs:
            walk(r)
    for g in groups.values():
        for q in g["requirements"]:
            walk(q["rule"])


def test_program_type_and_tidy_names(groups, majors):
    g = groups["major-chemical-engineering-nuclear-engineering-bs"] if "major-chemical-engineering-nuclear-engineering-bs" in groups else next(
        g for g in groups.values() if g["title"].startswith("Chemical Engineering/Nuclear"))
    assert g["kind"] == "major" and g["programType"] == "joint-major" and "Joint Major" not in g["title"]
    assert {g.get("programType") for g in groups.values() if g["kind"] == "major"} == {"major", "joint-major", "dual-degree"}
    assert not any("/ " in m["name"] or "Joint Major" in m["name"] for m in majors)
    titles = [q["title"] for q in groups["major-environmental-sciences-bs"]["requirements"]]
    assert "Methods and Seminars" in titles and not any("Mathmatics" in t for t in titles)


def test_clip_cuts_at_a_sentence_and_says_so():
    text = "First sentence here. " + "Second sentence is rather long and goes on. " * 20
    out = br.clip(text, 100)
    assert out.startswith("First sentence here.") and out.endswith("… (see the catalog for the rest)") and "goes on." in out
    assert br.clip("Short.", 100) == "Short."


def test_mentioned_courses_skip_excluded_and_graduate(groups):
    for g in groups.values():
        for q in g["requirements"]:
            r = q["rule"]
            if r["type"] == "manual" and "graduate" not in r["text"].lower():
                assert not [c for c in r.get("mentionedCourses", []) if int("".join(ch for ch in c.rsplit(" ", 1)[1] if ch.isdigit()) or 0) >= 200], (g["id"], q["id"])


def test_search_aliases_second_round(majors):
    by_name = {m["name"]: m["aliases"] for m in majors}
    assert {"dev studies"} <= set(by_name["Global Studies"]) and {"env sci", "envsci", "es"} <= set(by_name["Environmental Sciences"])
    assert {"melc", "near eastern", "jewish"} <= set(by_name["Middle Eastern Languages and Cultures"]) and "landscape" in by_name["Landscape Architecture"]
    minors = {m["name"]: m["aliases"] for m in load("data", "requirements", "minors.json")}
    assert {"city planning", "cp"} <= set(minors["City and Regional Planning"])


def test_c_numbered_twins_are_cross_listed(courses):
    assert "LINGUIS C105" in courses["COGSCI C101"]["crossListed"] and "COGSCI C101" in courses["LINGUIS C105"]["crossListed"]
    assert "COGSCI C131" in courses["COGSCI 131"]["sameAs"] and "COGSCI 131" in courses["COGSCI C131"]["sameAs"]
    for cid, c in courses.items():
        for o in c.get("crossListed", []):
            assert cid in courses[o]["crossListed"] and set(courses[o]["crossListed"]) | {o} == set(c["crossListed"]) | {cid}, (cid, o)
