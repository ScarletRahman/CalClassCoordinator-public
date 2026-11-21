# Requirements build report

Catalog year 2026-27, built from data/raw/catalog/ by scripts/build_requirements.py.

- Majors and dual/joint programs: 115 (BSE 1, CDSS 3, CED 4, CHEM 5, CNR 9, COE 27, HAAS 1, LS 65)
- Minors: 124
- Requirement groups: 254
- Courses: 7747; with a breadth area: 2687; AC: 253; AH&I: 24; ELW: 2; RCA: 36; RCB: 47; FL: 297; HSS: 2690; UD: 5606
- Requirements that include a self-check (manual) step: 213 of 1798, across 110 groups
- Course references the catalog could not resolve (retired courses): 112
- Validation errors: 0

## Groups with the most self-check rules

These are requirements the catalog states only in prose (for example "see the department's approved list").

- major-chemical-engineering-bs: 9 of 28 requirements include a self-check
- major-life-science-business-and-entrepreneurship-ba-bs: 7 of 135 requirements include a self-check
- major-molecular-and-cell-biology-ba: 6 of 49 requirements include a self-check
- major-educational-sciences-bs: 5 of 13 requirements include a self-check
- major-university-of-hong-kong-uc-berkeley-dual-degree-program-ba: 5 of 6 requirements include a self-check
- university: 5 of 7 requirements include a self-check
- college-CDSS: 5 of 6 requirements include a self-check
- college-LS-haas-seven-course-breadth: 5 of 7 requirements include a self-check
- college-LS: 4 of 5 requirements include a self-check
- college-BSE: 4 of 5 requirements include a self-check
- major-american-studies-ba: 3 of 8 requirements include a self-check
- major-bioengineering-bs: 3 of 12 requirements include a self-check
- major-bioengineering-and-business-administration-bs: 3 of 16 requirements include a self-check
- major-computer-science-ba: 3 of 5 requirements include a self-check
- major-ecosystem-management-and-forestry-bs: 3 of 3 requirements include a self-check
- major-electrical-engineering-and-computer-sciences-bs: 3 of 8 requirements include a self-check
- major-engineering-math-and-statistics-bs: 3 of 11 requirements include a self-check
- major-engineering-physics-bs: 3 of 17 requirements include a self-check
- major-mechanical-engineering-bs: 3 of 8 requirements include a self-check
- major-nuclear-engineering-bs: 3 of 8 requirements include a self-check
- major-sciences-po-uc-berkeley-dual-degree-program-ba: 3 of 4 requirements include a self-check
- major-society-and-environment-bs: 3 of 10 requirements include a self-check
- college-CED: 3 of 4 requirements include a self-check
- college-CHEM: 3 of 3 requirements include a self-check
- college-CHEM-coc-breadth-chemical-engineering: 3 of 3 requirements include a self-check

## Cross-check against the rendered catalog pages

The Requirements tab of every program was also saved as plain text. It lists 13197 course lines in total; 13 of them are not in the generated rules and 5952 courses in the rules are not on the page (a page shows a course set as one line, so courses that come from a set count as extra here).

- Energy Engineering: page lists 66; missing ['CIVENG 110']
- Armenian Studies: page lists 8; missing ['HISTORY 100M']
- Data Science: page lists 47; missing ['ENGIN 183C']
- Electrical Engineering and Computer Sciences and Business Administration: page lists 117; missing ['PHYSICS 5A', 'PHYSICS 5B', 'PHYSICS 7A', 'PHYSICS 7B']
- Mechanical Engineering and Business Administration: page lists 24; missing ['DESINV 190', 'MECENG 193G']
- Industrial Engineering and Operations Research and Business: page lists 76; missing ['PHYSICS 5A', 'PHYSICS 5B', 'PHYSICS 7A', 'PHYSICS 7B']

## Course coverage

- Courses in the catalog's own CSV export (data/raw/catalog/course_index.json.gz): 6742
- Courses added from Berkeleytime because the catalog no longer lists them (`source: berkeleytime`): 111
- Courses in a cross-listed family: 791
- Every catalog course and every undergraduate course in the predictions file is present.

## Same class under another number (`sameAs`): 243 families, 153 retired stubs

Links by evidence: formerly 199, C-prefix 79, same title and number 48, curated 5. Most enrolled families:

- MATH 1B = MATH 52
- MATH 1A = MATH 51
- CHEM 1AL = XCHEM 1AL
- EPS 20 = EPS C20 = LS C70Y
- COMPSCI 88 = COMPSCI C88C = DATA C88C
- ASTRON 10 = ASTRON C10 = LS C70U
- EECS 16B = ELENG 16B = ELENG 64
- MBN 10 = NUSCTX 10
- EECS 16A = ELENG 16A = ELENG 66
- MCELLBI 61 = MCELLBI C61 = NEU 61 = NEU C61 = PSYCH C61
- UGBA 107 = UGBA 170
- DATA C102 = STAT 102 = STAT C102
- COGSCI 131 = COGSCI C131 = PSYCH C123
- EECS 126 = ELENG 126
- LS C160V = PSYCH 162 = PSYCH C162
- GLOBAL 45 = HISTORY C1 = IAS 45 = POLECON 45 = POLECON C45
- COMPSCI C187 = DATA 101 = DATA C101
- ECON C110 = POLECON C135 = POLSCI C135
- GEOG C32 = GLOBAL 10A = GLOBAL C10A
- SOCIOL 101B = SOCIOL 102
- UGBA 10 = UGBA 10X
- SOCIOL 101 = SOCIOL 101A
- HISTART 1B = HISTART R1B
- ENGIN 45 = MATSCI 45
- LS C180U = PUBPOL 103 = PUBPOL C103
- COMPSCI 182 = COMPSCI C182 = DATA C182
- ENGIN 120 = INDENG 120
- MATH 3 = MATH 32 = XMATH 32
- ESPM 167 = ESPM C167 = PBHLTH C160
- DATA C88S = STAT 88 = STAT C88S

Old numbers since given to a different class, so not linked: ANTHRO 121 (formerly of ANTHRO 121A); ECON 135 (formerly of ECON N110); ELENG 16A (formerly of ELENG 66); ELENG 16B (formerly of ELENG 64); ETHSTD N190 (formerly of ETHSTD N180); HINURD 15 (formerly of HINDI 15); HISTART N181 (formerly of HISTART N186C); HISTORY 169 (formerly of HISTORY 169A); INTEGBI 108 (formerly of INTEGBI 113L); PHILOS 186 (formerly of PHILOS 188); RHETOR 100 (formerly of RHETOR 103A); RHETOR 173 (formerly of RHETOR 106); RHETOR 129 (formerly of RHETOR 133T); SLAVIC 39 (formerly of SLAVIC 36); SOCIOL 102 (formerly of SOCIOL 103); POLSCI 196W (formerly of POLSCI C196W); STAT C8R (formerly of DATA C6).

### Cross-listings inferred for C-numbered courses (77)

Same title and units under a C number in another subject, where the catalog named no partner for at least one of them.

- INTEGBI C32 = LS C30Z: Bio-Inspired Design
- MCELLBI C61 = PSYCH C61: Brain, Mind, and Behavior
- MCELLBI C61 = NEU C61: Brain, Mind, and Behavior
- BUDDSTD C124 = EALANG C124: Buddhism and Film
- BUDDSTD C122 = EALANG C122: Buddhist Meditation: Historical, Doctrinal, and Ethnographic Perspectives
- MCELLBI C130 = NUSCTX C130: Cell Biology: from Discovery to Disease
- MBN C130 = NUSCTX C130: Cell Biology: from Discovery to Disease
- DEVP C221 = PUBPOL C221: Climate, Energy and Development
- DEVP C221 = ENERES C221: Climate, Energy and Development
- ENERES C221 = PUBPOL C221: Climate, Energy and Development
- COGSCI C101 = LINGUIS C105: Cognitive Linguistics
- COMPSCI C280 = VISSCI C280: Computer Vision
- LS C30T = MCELLBI C62: Drugs and the Brain
- LS C30T = NEU C62: Drugs and the Brain
- MCELLBI C62 = NEU C62: Drugs and the Brain
- ESPM C254 = PBHLTH C202B: Ethnic and Cultural Diversity in Health Status
- INTEGBI C160 = MCELLBI C144: Evolution
- INTEGBI C109 = PLANTBI C109: Evolution and Ecology of Development
- ESPM C115C = INTEGBI C176L: Fish Ecology
- ESPM C216 = INTEGBI C216: Freshwater Ecology
- GWS C180Y = LS C180Y: Gender, Sex and Power
- EPS C242 = GEOG C241: Glaciology
- ESPM C282 = PBHLTH C271G: Health Implications of Climate Change
- CYPLAN C256 = PBHLTH C233: Healthy Cities
- RELIGST C165 = SASIAN C140: Hindu Mythology
- COGSCI C103 = MEDIAST C104C: History of Information
- COGSCI C103 = HISTORY C192: History of Information
- COGSCI C103 = INFO C103: History of Information
- HISTORY C192 = MEDIAST C104C: History of Information
- HISTORY C192 = INFO C103: History of Information
- INFO C103 = MEDIAST C104C: History of Information
- INTEGBI C143B = NEU C126: Hormones and Behavior
- INTEGBI C143B = PSYCH C116: Hormones and Behavior
- ESPM C159 = NUSCTX C159: Human Diet
- INTEGBI C130 = SOCIOL C118: Human Fertility
- LS C160V = PSYCH C162: Human Happiness
- GERMAN C160G = LS C120T: Ideas of Education
- CHINESE C185 = PHILOS C167: Introduction to Chinese Philosophy
- ENGLISH C77 = ESPM C12: Introduction to Environmental Studies
- ANTHRO C103 = INTEGBI C142L: Introduction to Human Osteology
- EECS C106A = ELENG C106A: Introduction to Robotics
- BIOENG C106A = ELENG C106A: Introduction to Robotics
- ELENG C106A = MECENG C106A: Introduction to Robotics
- INTEGBI C125L = PHYSED C165L: Introduction to the Biomechanical Analysis of Human Movement
- BIOENG C145M = ELENG C145M: Introductory Microcomputer Interfacing Laboratory
- EECS C128 = ELENG C128: Invitation to Intelligent Control
- ELENG C128 = MECENG C134: Invitation to Intelligent Control
- HISTORY C175A = UGIS C154: Jewish Civilization: Middle Ages
- HISTORY C175A = RELIGST C134: Jewish Civilization: Middle Ages
- RELIGST C134 = UGIS C154: Jewish Civilization: Middle Ages
- COGSCI C147 = LINGUIS C147: Language Disorders
- LINGUIS C139 = SLAVIC C139: Language Spread
- HISTORY C111B = SEASIAN C141B: Modern Southeast Asia
- GEOG C152 = ISF C145: Multicultural Europe
- GEOG C152 = HISTORY C176: Multicultural Europe
- HISTORY C176 = ISF C145: Multicultural Europe
- MUSIC C128P = PHILOS C112: Music and Meaning
- INTEGBI C147 = PSYCH C115C: Neuroethology: Complex Animal Behaviors and Brains
- INTEGBI C147 = NEU C125: Neuroethology: Complex Animal Behaviors and Brains
- ASTRON C180 = PHYSICS C101: Order-Of-Magnitude Physics
- ASTRON C101 = PHYSICS C180: Order-Of-Magnitude Physics
- ASTRON C101 = PHYSICS C101: Order-Of-Magnitude Physics
- AST C239 = ELENG C239: Partially Ionized Plasmas
- INTEGBI C107L = PLANTBI C107L: Principles of Plant Morphology with Laboratory
- COGSCI C124 = PSYCH C124: Psycholinguistics
- EDUC C122 = UGIS C122: Research Methods for Science and Mathematics K-12 Teachers
- EDSTEM C122 = UGIS C122: Research Methods for Science and Mathematics K-12 Teachers
- GERMAN C25 = LS C60U: Revolutionary Thinking: Marx, Nietzsche, Freud
- ANTHRO C147B = LGBT C147B: Sexuality, Culture, and Colonialism
- LGBT C147B = QTP C147B: Sexuality, Culture, and Colonialism
- CHINESE C184 = MUSIC C134C: Sonic Culture in China
- NEUROSC C129 = PBHLTH C129: The Aging Human Brain
- HISTORY C187 = LS C140V: The History and Practice of Human Rights
- DUTCH C179 = JEWISH C179: The Jews of the Low Countries
- COGSCI C104 = LINGUIS C104: The Mind, Language, and Politics
- CYPLAN C117 = PBHLTH C150E: Urban and Community Health
- CYPLAN C139 = POLSCI C139: Urban and Sub-national Politics in Developing Countries

Repeated entries dropped from course lists: 52.

## Optional requirements (`optional: true`): 2

- major-applied-mathematics-ba: Honors / Thesis
- major-applied-mathematics-ba: Honors / Graduate Level Math Courses

## Prose rules folded into the notes of the requirement below them (30)

- major-aerospace-engineering-bs: Technical Electives / Requirements
- major-aerospace-engineering-and-business-administration-bs: Technical Electives / Requirements
- major-analytics-ba: Upper Division Electives / Concentration Electives
- major-anthropology-ba: Electives / (untitled)
- major-applied-mathematics-ba: Honors / Requirements
- minor-astrophysics: Prerequisites / (untitled)
- minor-city-and-regional-planning: Lower Division / (untitled)
- minor-city-and-regional-planning: Upper Division Electives / (untitled)
- major-dutch-studies-ba: Upper Division / (untitled)
- major-east-asian-humanities-ba: Electives / Areas
- major-economics-ba: Upper Division Requirements / Course Requirements
- major-environmental-economics-and-policy-bs: Upper Division / (untitled)
- major-ethnic-studies-ba: Lower Division / Requirement
- minor-food-systems: Upper Division Core / Areas
- minor-food-systems: Upper Division Electives / Categories
- major-french-ba: Upper Division / Note
- major-geography-ba: Lower Division Requirements / Areas
- major-german-ba: Upper Division / Requirements
- minor-german: Upper Division / Requirements
- major-integrative-biology-ba: Lower Division / Requirements
- minor-israel-studies: Upper Division / Requirements
- major-latin-ba: Lower Division / (untitled)
- major-legal-studies-ba: Distribution Requirement / Course Requirements
- major-mathematics-ba: Teaching Concentration: Upper Division Core and Electives / Requirements
- major-media-studies-ba: Lower Division Requirements / Requirements
- major-microbial-biology-bs: Concentrations / Choose Option 1 or Option 2
- major-molecular-environmental-biology-bs: Concentrations / Area of Concentration
- minor-political-economy: Electives / Electives
- major-public-health-ba: Prerequisites / Note
- major-statistics-ba: Cluster Courses / Requirement

## Units: 33 umbrella courses took the range of their lettered offerings; still 0 units: AEROSPC 100, AMERSTD 39, ENVDES 193, LANPRO 100A, LANPRO 100B, LANPRO 150A, MILSCI 1, PERSIAN 190

## Programs with a choice

Concentrations, emphases, tracks and the like: the student completes one option. Decided per program in data/requirements/overrides/choices.json.

- major-analytics-ba: Concentration (pick 1 of 4): Economic Systems; Industrial and Business Systems; Societal Systems; Algorithmic and Decision Analytics
- major-applied-mathematics-ba: Cluster (pick 1 of 19): Actuarial Science; Classical Mechanics; Computer Science; Data Science; Economics; Fluid Mechanics; Geophysics; Life & Physical Science; Logic; Mathematical Biology; Numerical Analysis; Operations Research; Probability Theory; Quantum Mechanics; Relativity; Social Sciences; Statistics; Systems Theory; Individual
- major-architecture-ba: Senior Year Track (pick 1 of 2): Studio Track; Research Track
- major-business-administration-bs: Concentration (pick 1 of 2): No concentration; Global Management Program
- major-chemical-biology-bs: Concentration (pick 1 of 2): Chemistry & Allied Subjects (no concentration); Computational Chemistry
- major-chemical-engineering-bs: Concentration (pick 1 of 7): Open Elective Program (no concentration); Applied Physical Science; Biotechnology; Business and Management; Chemical Processing; Energy & Environment; Materials Science & Technology
- major-chemistry-bs: Concentration (pick 1 of 3): Chemistry & Allied Subjects (no concentration); Computational Chemistry; Materials Chemistry
- major-data-science-ba: Domain Emphasis (pick 1 of 28): Aerospace; Applied Mathematics and Modeling; Business and Industrial Analytics; Cognition; Computational Methods in Molecular and Genomic Biology; Data Arts and Humanities; Ecology and the Environment; Economics; Education; Environment, Resource Management, and Society; Evolution and Biodiversity; Geospatial Information and Technology; Human and Population Health; Human Behavior and Psychology; Inequalities in Society; Linguistic Sciences; Neurosciences; Organizations and the Economy; Philosophical Foundations: Evidence and Inference; Philosophical Foundations: Minds, Morals, and Machines; Physical Science Analytics; Quantitative Social Science; Robotics; Science, Technology, and Society; Social Welfare, Health, and Poverty; Social Policy and Law; Sustainable Development and Engineering; Urban Science
- major-earth-and-planetary-science-ba: Specialization (pick 1 of 6): Atmospheric Science; Environmental Earth Science; Geology; Geophysics; Marine Science; Planetary Science
- major-ecosystem-management-and-forestry-bs: Specialization (pick 1 of 2): Forestry; Natural Resource Management
- major-environmental-sciences-bs: Concentration (pick 1 of 3): Biological Sciences; Physical Sciences; Social Sciences
- major-global-studies-ba: Concentration (pick 1 of 3): Global Development; Global Peace & Conflict; Global Societies and Cultures
- major-integrative-biology-ba: Emphasis (pick 1 of 2): Ecology, Evolution, and Organismal Biology; Integrative Human Biology
- major-life-science-business-and-entrepreneurship-ba-bs: Life Science Major and Emphasis (pick 1 of 15): Integrative Biology: Ecology, Evolution, and Organismal Biology; Integrative Biology: Integrative Human Biology; Molecular and Cell Biology: Biochemistry, Biophysics & Structural Biology: Track 1; Molecular and Cell Biology: Biochemistry, Biophysics & Structural Biology: Track 2; Molecular and Cell Biology: Cell Biology, Development & Physiology: Track 1; Molecular and Cell Biology: Cell Biology, Development & Physiology: Track 2; Molecular and Cell Biology: Genetics, Genomics, Evolution & Development: Track 1; Molecular and Cell Biology: Genetics, Genomics, Evolution & Development: Track 2; Molecular and Cell Biology: Immunology and Molecular Medicine: Track 1; Molecular and Cell Biology: Immunology and Molecular Medicine: Track 2; Molecular and Cell Biology: Immunology and Molecular Medicine: Track 3; Molecular and Cell Biology: Molecular Therapeutics: Track 1; Molecular and Cell Biology: Molecular Therapeutics: Track 2; Molecular and Cell Biology: Neurobiology; Neuroscience
- major-mathematics-ba: Upper Division Program (pick 1 of 2): Mathematics (no concentration); Teaching Concentration
- major-mechanical-engineering-bs: Concentration (pick 1 of 2): No concentration; Aerospace Engineering
- major-media-studies-ba: Concentration (pick 1 of 3): Digital Studies; Global Cultural Studies; Media Law and Policy
- major-microbial-biology-bs: Concentration (pick 1 of 5): General Microbiology; Host-Pathogen Interactions; Evolution/Computational Genomics; Ecology & Environmental Microbiology; Microbial Biotechnology
- major-middle-eastern-languages-and-cultures-ba: Specialization and Emphasis (pick 1 of 5): Middle Eastern Worlds: Ancient Worlds; Middle Eastern Worlds: Modern Worlds; Middle Eastern Languages and Literature: Arabic; Middle Eastern Languages and Literature: Hebrew; Middle Eastern Languages and Literature: Persian
- major-molecular-and-cell-biology-ba: Emphasis (pick 1 of 12): Biochemistry, Biophysics & Structural Biology: Track 1; Biochemistry, Biophysics & Structural Biology: Track 2; Cell Biology, Development & Physiology: Track 1; Cell Biology, Development & Physiology: Track 2; Genetics, Genomics, Evolution & Development: Track 1; Genetics, Genomics, Evolution & Development: Track 2; Immunology and Molecular Medicine: Track 1; Immunology and Molecular Medicine: Track 2; Immunology and Molecular Medicine: Track 3; Molecular Therapeutics: Track 1; Molecular Therapeutics: Track 2; Neurobiology
- major-molecular-environmental-biology-bs: Area of Concentration (pick 1 of 6): Animal Health and Behavior; Biodiversity; Ecology; Environment and Human Health; Global Change Biology; Insect Biology
- major-political-science-ba: Subfield Specialization (pick 1 of 5): American Politics; Comparative Politics; Empirical Theory & Quantitative Methods; Political Theory; International Relations
- major-rhetoric-ba: Concentration (pick 1 of 3): History and Theory; Public Discourse; Narrative and The Image
- major-scandinavian-ba: Concentration (pick 1 of 5): Danish; Finnish; Norwegian; Old Norse Studies; Swedish
- major-slavic-languages-and-literatures-ba: Track (pick 1 of 3): Russian, East European and Eurasian Cultures Track: Concentration in Armenian, BCS (Bosnian/Croatian/Serbian), Czech, Hungarian, Polish, or Ukrainian Language; Czech, Polish, BCS Track: Concentration in Russian (R-1865); Russian Language and Literature Track
- major-sociology-ba: Upper Division Program (pick 1 of 2): Sociology Major; Sociological Research Methods Concentration
- major-spanish-and-portuguese-ba: Concentration (pick 1 of 4): The Languages, Literatures, and Cultures of the Spanish-Speaking World; The Languages, Literatures, and Cultures of the Portuguese-Speaking World; Latin American Languages, Literatures, and Cultures; Hispanic Linguistics
- minor-data-science: Upper Division Pathway (pick 1 of 2): Data Pathway; Statistics Pathway

## Alternatives merged into one requirement (42)

- major-aerospace-engineering-bs: "Physics B" = any one of 2 options
- major-analytics-ba: "Computer Programming" = any one of 2 options
- major-business-administration-bs: "Statistics" = any one of 2 options
- minor-city-and-regional-planning: "Lower Division" = 2 of 3 (Economics; Statistics; Environmental Design) [override]
- major-data-science-ba: "Linear Algebra" = any one of 2 options
- major-data-science-ba: "Upper Division Course 2" = any one of 2 options
- major-earth-and-planetary-science-ba: "Physics" = any one of 2 options
- major-earth-and-planetary-science-ba: "Physics B Series" = any one of 2 options
- major-earth-and-planetary-science-ba: "Physics B Series" = any one of 2 options
- major-earth-and-planetary-science-ba: "Physics B Series" = any one of 2 options
- major-earth-and-planetary-science-ba: "Physics C Series" = any one of 2 options
- major-earth-and-planetary-science-ba: "Physics B Series" = any one of 2 options
- major-earth-and-planetary-science-ba: "Physics B Series" = any one of 2 options
- major-earth-and-planetary-science-ba: "Physics C Series" = any one of 2 options
- major-east-asian-humanities-ba: "Comparative East Asian Culture" = 2 of 4 (Buddhist Studies; China; Japan; Korea) [override]
- major-east-asian-religion-thought-and-culture-ba: "Intermediate Language Series" = any one 4 (Chinese Language Series; Chinese Heritage Language Series; Japanese Language Series; Tibetan) [override]
- minor-eastern-european-and-eurasian-languages-and-cultures: "Language Sequence" = any one 6 (Polish; Czech; Armenian; Hungarian; Bosnian, Croatian and Serbian; Ukrainian) [override]
- major-electrical-engineering-and-computer-science-materials-science-and-engineering-bs: "Physics" = any one of 2 options
- major-electrical-engineering-and-computer-science-nuclear-engineering-bs: "Physics" = any one of 2 options
- major-electrical-engineering-and-computer-sciences-and-business-administration-bs: "Natural Science" = any one of 7 options
- major-engineering-physics-bs: "Physics" = any one of 2 options
- major-engineering-physics-bs: "Electromagnetism and Optics" = any one of 2 options
- major-environmental-sciences-bs: "Biology" = any one of 2 options
- major-environmental-sciences-bs: "Biology" = any one of 2 options
- major-geography-ba: "Research Areas" = 4 of 5 (A. Earth System Science; B. Political Economies; C. Racial Geographies; D. Critical Environments; E. Geospatial Representation) [override]
- minor-geography: "Research Areas" = 3 of 5 (A. Earth System Science; B. Political Economies; C. Racial Geographies; D. Critical Environments; E. Geospatial Representation) [override]
- major-global-studies-ba: "Geographic Focus" = any one 5 (Asia; Africa; Europe & Russia; The Americas; Middle East & North Africa) [override]
- major-global-studies-ba: "Geographic Focus" = any one 5 (Asia; Africa; Europe & Russia; The Americas; Middle East & North Africa) [override]
- major-global-studies-ba: "Geographic Focus" = any one 5 (Asia; Africa; Europe & Russia; The Americas; Middle East & North Africa) [override]
- major-history-ba: "World Regions" = 3 of 6 (Africa; Asia; Europe; Latin America & The Caribbean; Near & Middle East; North America) [override]
- major-history-ba: "Senior Thesis Research Seminar" renamed "Senior Thesis Research Seminar" (no other option listed)
- major-integrative-biology-ba: "Mathematics" = 2 of 3 (Math List A; Math List B; Math List C) [override]
- major-life-science-business-and-entrepreneurship-ba-bs: "Statistics" = any one of 2 options
- major-linguistics-ba: "Upper Division Bins" = 4 of 5 (Language and Mind; Sociolinguistics and Historical Linguistics; Phonetics and Phonology; Morphosyntax; Meaning) [override]
- minor-linguistics: "Upper Division Bins" = 2 of 5 (Language and Mind; Sociolinguistics and Historical Linguistics; Phonetics and Phonology; Morphosyntax; Meaning) [override]
- major-materials-science-and-engineering-and-business-administration-bs: "Lower Division Statistics Requirement" = any one of 2 options
- major-mathematics-ba: "Semi-Electives" = 2 of 3 (Computing; Geometry; Logic & Foundations) [override]
- major-microbial-biology-bs: "General Microbiology" = 4 of 4 (Host-Pathogen Interactions; Evolution/Computational Genomics; Ecology & Environmental Microbiology; Microbial Biotechnology) [override]
- major-molecular-and-cell-biology-ba: "Mathematics" = any one of 3 options
- major-molecular-environmental-biology-bs: "Upper Division Laboratory" = any one 2 (Option 1: independent study or research plus one laboratory course; Option 2: two laboratory courses) [override]
- major-nutrition-and-metabolic-biology-bs: "Mathematics" = any one 2 (Option 1: Math 10 series; Option 2: Math A, Math B and Statistics) [override]
- major-political-science-ba: "Methods" = any one of 2 options

Option-like rows left as they are (not siblings of one requirement):

- major-microbial-biology-bs: Concentrations / Choose Option 1 or Option 2

## Prose lists converted to checkable rules (90)

- African American Studies: Electives
- African American Studies: Courses
- Ancient Greek and Roman Studies: Electives
- Ancient Greek and Roman Studies: Minor Coursework
- Asian American and Asian Diaspora Studies: Outside Electives
- Bioengineering: Electives
- Bioengineering: Technical Topics
- Bioengineering: Bioengineering Upper Division
- Chicanx Latinx Studies: Program Course
- Chinese Language and Culture: EALC Electives
- Cognitive Science: Electives
- Computer Science: Electives
- Data Science: Electives
- Dutch Studies: Additional Electives
- Dutch Studies: Core
- East Asian Religion, Thought, and Culture: List A
- Electrical Engineering and Computer Sciences and Business Administration: Natural Science: Option 7
- Engineering Math and Statistics: Mathematics Elective
- Engineering Math and Statistics: Additional Math/Statistics Elective
- Environmental Engineering: Upper Division Technical Elective
- Ethnic Studies: Electives
- Gender and Women's Studies: Electives
- German: Electives
- Global Studies: Geographic Focus: Asia
- Global Studies: Geographic Focus: Africa
- Global Studies: Geographic Focus: Europe & Russia
- Global Studies: Geographic Focus: The Americas
- Global Studies: Geographic Focus: Middle East & North Africa
- Global Studies: Geographic Focus: Asia
- Global Studies: Geographic Focus: Africa
- Global Studies: Geographic Focus: Europe & Russia
- Global Studies: Geographic Focus: The Americas
- Global Studies: Geographic Focus: Middle East & North Africa
- Global Studies: Geographic Focus: Asia
- Global Studies: Geographic Focus: Africa
- Global Studies: Geographic Focus: Europe & Russia
- Global Studies: Geographic Focus: The Americas
- Global Studies: Geographic Focus: Middle East & North Africa
- Global Studies: Africa, North and Sub-Saharan: Disciplinary Course
- Global Studies: Asia: Disciplinary Course
- Global Studies: Europe and Russia: Disciplinary Course
- Global Studies: The Americas: Disciplinary Course
- Global Studies: The Middle East and North Africa: Disciplinary Course
- Greek: Greek Senior Reading Courses
- Greek: Greek & Roman Civilization
- Greek: Greek
- Greek and Latin: Senior Reading
- Greek and Latin: Greek & Roman Civilization
- History: Electives
- Japanese: Core
- Japanese: Electives
- Japanese Language and Culture: East Asian Comparative Culture
- Japanese Language and Culture: EALC Electives
- Japanese Language and Culture: East Asian Comparative Culture
- Japanese Language and Culture: EALC Electives
- Korean: Core
- Latin: Latin Senior Reading Courses
- Latin: Greek and Roman Civilization
- Latin: Latin
- Life Science, Business, and Entrepreneurship: Electives
- Life Science, Business, and Entrepreneurship: Electives
- Life Science, Business, and Entrepreneurship: Electives
- Life Science, Business, and Entrepreneurship: Electives
- Life Science, Business, and Entrepreneurship: Electives
- Life Science, Business, and Entrepreneurship: Electives
- Life Science, Business, and Entrepreneurship: Electives
- Life Science, Business, and Entrepreneurship: Neuroscience Electives
- Life Science, Business, and Entrepreneurship: Outside Perspectives
- Mathematics: Courses
- Mechanical Engineering: Quantitative Science
- Mechanical Engineering: Electives
- Media Studies: Additional Electives
- Native American Studies: Program Course
- Philosophy: Electives
- Political Science: Courses
- Portuguese Languages, Literatures & Cultures: Upper Division
- Queer and Trans Praxis: Elective 1
- Queer and Trans Praxis: Elective 2
- Scandinavian: Electives
- Scandinavian: Electives
- Scandinavian: Electives
- Scandinavian: Electives
- Scandinavian: Electives
- Social Welfare: Social Welfare Topics
- Sociology: Electives
- South and Southeast Asian Studies: Electives
- Spanish and Portuguese: Literature and Culture Electives
- Spanish and Portuguese: Spanish & Portuguese Electives
- Spanish Languages, Literatures and Cultures: Core
- Statistics: Approved Cluster Courses

## Headings the catalog wrote as rules (9; kept as notes or dropped)

- Chemical Engineering: Open Elective Program / Students who do not choose a concentration must complete the following requirements for the open elective program.
- Dance and Performance Studies: Upper Division / Students must complete each course for a letter grade unless offered only on a pass/no pass basis.
- History: Upper Division / Students must complete five upper division courses and must take one course from two separate fields.
- Linguistics: Upper Division / Students must complete 1 course from 4 of the 5 bins, each with a letter grade.
- Linguistics: Upper Division / Students must complete 1 course from 2 of the 5 bins, each with a letter grade.
- Music: Lower Division / Students must complete each course with a letter grade of C- or higher.
- Music: Upper Division / A maxiumum of 1 course is allowed from MUSIC 151A–D for all requirements.
- Nutrition and Metabolic Biology: Mathematics Options / Students may complete the Math 10 series (Option 1), or one Math A series course, one Math B series course, and one Statistics course (Option 2).
- Social Welfare: Lower Division / Students must complete each course with a letter grade.

## Section and title corrections

- major-cognitive-science-ba: "Cognitive Neuroscience" -> "Upper Division" (7 requirements)
- major-data-science-ba: Sustainable Development and Engineering / (untitled) -> "Lower Division"

## Section audit

Catalog blocks named exactly like their own first rule while holding other rules (the Cognitive Science symptom). Each is either fixed by a renameSections override or reviewed and listed in AUDIT_OK.

- none left

## Warnings

- Applied Mathematics: 'Logic' asks for 3 but lists only 2 current courses; treated as all
- Civil Engineering and Business Administration: 'CEE Applications' asks for 9 but lists only 8 current courses; treated as all
- Dutch Studies: 'Core' asks for 2 but lists only 1 current courses; treated as all
- Engineering Physics: 'Physics: Option 2' asks for 5 but lists only 1 current courses; treated as all
- Forestry and Natural Resources: no structured requirements in the catalog
- Slavic Languages and Literatures: 'Electives' asks for 6 but lists only 5 current courses; treated as all
- college-CHEM-variant: requisite set Z4CKX4oi4q not captured
- college-CHEM-variant: requisite set sMlB9ZhB70 not captured

## Retired course references dropped

- Anthropology: 1
- Asian American and Asian Diaspora Studies: 12
- Bioengineering: 9
- Chemical Engineering: 1
- City and Regional Planning: 1
- Cognitive Science: 16
- Data Science: 3
- Electrical Engineering and Computer Science: 1
- Energy Engineering: 8
- Engineering Math and Statistics: 3
- Engineering Physics: 11
- Environmental Sciences: 1
- Global Studies: 19
- Global Studies: Africa, North and Sub-Saharan: 2
- Global Studies: Asia: 3
- Global Studies: Europe and Russia: 2
- Global Studies: The Americas: 2
- Global Studies: The Middle East and North Africa: 2
- Legal Studies: 11
- Mechanical Engineering and Business Administration: 4
