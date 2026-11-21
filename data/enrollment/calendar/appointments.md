# How Berkeley enrollment appointments work (Fall 2016 to Spring 2027)

Companion to `phases.json`. These notes cover the enrollment mechanics that drive when classes fill.

## Phase structure
- **Phase I (continuing students).** It opens in mid-April for fall terms and mid-October for spring terms, and runs about 3 to 9 weeks. Each student gets an individual **appointment start time** inside the window and can enroll from that time until Phase I ends. Appointments are posted on CalCentral about two weeks before Phase I opens.
- **Gap.** Between the end of Phase I and the student's Phase II appointment, the schedule is frozen and no changes are allowed (registrar Guide to Enrollment Rules, 2018).
- **Phase II (continuing students).** For fall terms it opens in mid or late July. For spring terms it opens in mid-November, about a week after Phase I closes. Phase II has its own staggered appointments and runs until the day before the Adjustment Period.
- **New students.** New transfers and first-years get a single Phase I in July (fall) or in mid-November (spring, since about 2021). Transfers usually start 1 to 2 days before first-years, and new grads come after both. **Incoming students have no Phase II.** Their Phase I runs until the Adjustment Period, with a 17.5-unit cap (L&S Advising). Since 2018, new students' Phase I has started about one week before continuing students' Phase II. This produces a July spike in lower-division demand.
- **Adjustment Period.** It starts the Monday about 9 days before instruction, and the cap is the college maximum (20.5 units in L&S). In 2016–2017 the add/drop deadline was the **Friday of week 5**. From Fall 2018 it moved to the **Wednesday of week 4**, and that is the last CalCentral add. Since about Spring 2023, the registrar calendar shows the Adjustment Period ending around the Friday of week 10. In `phases.json`, the "Add/Drop Deadline" entry marks the real end of adding.
- **One-off.** Fall 2020 had a "Phase 1.5" for continuing undergrads (July 8–11, 2020) and for grads (July 10–13).

## Unit caps (they include waitlisted units)
| Effective | Phase I | Phase II (total) | Source |
|---|---|---|---|
| Tele-BEARS era to Fall 2016 | 10.5 | 16 | Daily Cal, "Phase II unit cap raised to 17.5 units" |
| Spring 2017 | 10.5 | **17.5** | same article (approved by the Council of Undergraduate Deans; undergrads only) |
| Fall 2017 onward | **13.5** | 17.5 | Daily Cal, "Phase I enrollment unit cap raised from 10.5 to 13.5 units" |
| Current (2024–2026) | 13.5 | 17.5; adjustment 20.5 | L&S Advising, College of Chemistry, Daily Cal (Apr 2023) |

Effect on the model: since Fall 2017, a continuing student can reach full-time status (about 12 to 13.5 units) in Phase I. This pulls demand earlier, so popular classes fill more completely in Phase I than they did in 2016–2017.

## How appointment times are assigned
- **Undergraduates.** Appointments are grouped by **terms in attendance**, and students with more terms enroll earlier in each phase. The registrar counts terms 1–8+, counting only fall and spring terms, and **transfers start at 5**. **Within a group, slots are randomly assigned.** **GPA and units completed do not affect** undergrad appointment order. This comes from the registrar via the Daily Cal (Apr 21, 2023) and the College of Chemistry ("based on # of terms in attendance and status"). Academic level (freshman under 30 units, sophomore 30–59, junior 60–89, senior 90+) is a separate classification and does not set the order.
- **Graduate students** get appointment slots ordered by **units completed** (Daily Cal, 2023).
- **Priority groups** come before the normal order: student-athletes, veterans/student-veterans, and DSP (disability) students with priority enrollment. They are described as exceptions to the terms-in-attendance rule. The 2017 Daily Cal also notes that upper-division and continuing students get earlier appointments than new undergraduates.
- **Reserved seats** are controlled by departments, not appointments. Reservations for majors, new first-years, transfers and similar groups can be set per phase and are often released at Phase II or at the Adjustment Period. A class can show open seats that only one group can take. Departments may also enroll from manual waitlists any time from the first day of Phase I through week 4.

## Year-by-year changes worth encoding as features
- Fall 2016: first term on CalCentral/SIS, which replaced Tele-BEARS.
- Spring 2017: the Phase II cap went from 16 to 17.5.
- Fall 2017: the Phase I cap went from 10.5 to 13.5. Phase I also ended early, on June 28 (it usually ends in mid-June).
- Fall 2018: the add/drop deadline moved to the Wednesday of week 4, and new-undergrad Phase I became a defined July window.
- Fall 2020: remote term, with the extra Phase 1.5.
- Spring 2021 onward: new-student Phase I comes in November, before continuing Phase II.
- Spring 2023 onward: spring Phase I lasts 3 weeks (mid-Oct to early Nov, later late Oct to mid-Nov), and Phase II opens about 1 week later. Fall Phase I runs about 8 to 9 weeks (mid/late April to mid-June).

## Sources
- Registrar Student Enrollment Calendars, 2016-17 to 2020-21 (PDFs linked from https://registrar.berkeley.edu/calendars/enrollment-calendar/). Fall 2021 onward is published only as a Google Calendar, which Berkeleytime mirrors (`enrollmentTimeframes` GraphQL).
- Registrar Guide to Enrollment Rules: https://registrar.berkeley.edu/wp-content/uploads/Guide-to-Enrollment-Rules-v1.h-8-31-18.pdf
- Undergraduate classifications (terms in attendance): https://registrar.berkeley.edu/enrollment/how-to-enroll-in-classes/undergraduate-classifications/
- Daily Cal: https://www.dailycal.org/archives/phase-i-enrollment-unit-cap-raised-from-10-5-to-13-5-units/article_a1e66b9b-fe4a-541d-b183-198de7c33d56.html ; https://www.dailycal.org/archives/phase-ii-unit-cap-raised-to-17-5-units/article_8f6815bc-3820-5e6c-9ad8-23a975855d47.html ; https://www.dailycal.org/archives/campus-explains-policies-rules-behind-class-enrollment/article_872301b1-9971-5384-9bbc-c4e9f4681db4.html
- L&S Advising: https://lsadvising.berkeley.edu/progress-planning/schedule-planning-and-enrollment/enrollment-add-or-drop-course
- College of Chemistry: https://chemistry.berkeley.edu/ugrad/current-students/enrollment-advising and https://chemistry.berkeley.edu/ugrad/current-students/important-dates
