// Pure role -> prep guidance mapping shared by the AI-plan fallback
// (role-varied starter plans) and the deterministic report role brief
// (skills section). No I/O, no AI: unit tested for honesty + variety.

export interface RoleQuestion {
  question: string;
  topic: string;
  difficulty: "Easy" | "Medium" | "Hard";
  why: string;
}

export interface RoleProfile {
  skills: string[];
  rounds: { name: string; focus: string }[];
  questions: RoleQuestion[];
  aptitudeTopics: { topic: string; weight: number; tip: string }[];
}

const GENERIC: RoleProfile = {
  skills: [
    "Core skills listed in the job description",
    "Aptitude speed: quant + logical reasoning",
    "STAR-style behavioural answers",
    "Excel / docs fluency",
    "Clear written communication",
    "Resume-to-proof mapping (projects, metrics)",
  ],
  rounds: [
    { name: "HR / introductory round", focus: "Intro, motivation, location and notice period" },
    { name: "Technical / functional round", focus: "Core skills for the role, proven with examples" },
    { name: "Hiring manager round", focus: "Depth, ownership and how you handle trade-offs" },
  ],
  questions: [
    { question: "Tell me about yourself in 60 seconds.", topic: "Intro", difficulty: "Easy", why: "Sets the frame for everything after it" },
    { question: "Why this company and this role?", topic: "Motivation", difficulty: "Easy", why: "Shows you did basic research" },
    { question: "Walk me through a project you are proud of.", topic: "Project deep-dive", difficulty: "Medium", why: "Reveals depth and your real contribution" },
    { question: "Describe a problem you debugged end to end.", topic: "Problem solving", difficulty: "Medium", why: "Tests method over memorised answers" },
    { question: "How do you prioritise when two deadlines collide?", topic: "Judgement", difficulty: "Medium", why: "Surfaces trade-off thinking" },
    { question: "What is a trade-off you regret from a past project?", topic: "Reflection", difficulty: "Hard", why: "Separates thoughtful candidates from scripted ones" },
  ],
  aptitudeTopics: [
    { topic: "Quantitative aptitude", weight: 35, tip: "Percentages, ratios, time-speed-distance - the evergreen trio" },
    { topic: "Logical reasoning", weight: 25, tip: "Sequencing, seating arrangements, syllogisms" },
    { topic: "Verbal ability", weight: 20, tip: "Reading comprehension speed plus error spotting" },
    { topic: "Data interpretation", weight: 12, tip: "Tables, bar charts and approximation maths" },
    { topic: "Programming basics", weight: 8, tip: "Arrays, strings, SQL fundamentals and time complexity" },
  ],
};

const SOFTWARE: RoleProfile = {
  skills: [
    "Data structures & algorithms",
    "A primary language (Java / Python / JavaScript)",
    "Problem solving under time limits",
    "SQL & database basics",
    "Version control (Git) and code review habits",
    "System design fundamentals",
  ],
  rounds: [
    { name: "Online coding round", focus: "2-3 DSA problems: arrays, strings, graphs or DP" },
    { name: "Technical interview", focus: "Project deep-dive, language internals, SQL, debugging" },
    { name: "Hiring manager round", focus: "System design basics, ownership, trade-offs" },
    { name: "HR round", focus: "Intro, motivation, location, notice period and compensation" },
  ],
  questions: [
    { question: "Walk through your best project's architecture and your exact part in it.", topic: "Project deep-dive", difficulty: "Medium", why: "Proves you owned something end to end" },
    { question: "Given an array, find two numbers that add up to a target - talk through your approach first.", topic: "DSA", difficulty: "Medium", why: "Shows method before code" },
    { question: "Design a URL shortener that handles 10k requests per second.", topic: "System design", difficulty: "Hard", why: "Tests scaling instincts, not memorised diagrams" },
    { question: "How would you find slow queries in a service?", topic: "Databases", difficulty: "Medium", why: "Reveals real production experience" },
    { question: "Tell me about a bug that took you a long time to find.", topic: "Debugging", difficulty: "Medium", why: "Tests patience and systematic thinking" },
  ],
  aptitudeTopics: [
    { topic: "Quantitative aptitude", weight: 30, tip: "Percentages, ratios, time-speed-distance - the evergreen trio" },
    { topic: "Logical reasoning", weight: 25, tip: "Sequencing, coding-decoding, syllogisms" },
    { topic: "Programming basics", weight: 20, tip: "Arrays, strings, SQL fundamentals and time complexity" },
    { topic: "Verbal ability", weight: 15, tip: "Reading comprehension speed plus error spotting" },
    { topic: "Data interpretation", weight: 10, tip: "Tables, bar charts and approximation maths" },
  ],
};

const DATA: RoleProfile = {
  skills: [
    "SQL (joins, aggregations, window functions)",
    "Statistics & probability basics",
    "Excel / spreadsheets (lookups, pivots)",
    "Python or R for analysis",
    "Dashboarding (Power BI / Tableau)",
    "Storytelling with data for non-technical stakeholders",
  ],
  rounds: [
    { name: "SQL / practical round", focus: "Live queries on joins, group-by and edge cases" },
    { name: "Analytics case round", focus: "Metric dips, funnels and experiment design" },
    { name: "Hiring manager round", focus: "How you prioritise analyses and communicate trade-offs" },
    { name: "HR round", focus: "Intro, motivation, location and notice period" },
  ],
  questions: [
    { question: "Write a query to find the second-highest value per group.", topic: "SQL", difficulty: "Medium", why: "Covers window functions and dense ranking" },
    { question: "A core metric dropped 15% overnight - how do you investigate?", topic: "Analytics case", difficulty: "Medium", why: "Tests structured hypothesis thinking" },
    { question: "How would you design a funnel dashboard for checkout?", topic: "Dashboarding", difficulty: "Medium", why: "Shows you think about drop-off, not just charts" },
    { question: "Explain a correlation you would NOT trust for a business decision.", topic: "Statistics", difficulty: "Hard", why: "Separates analysts from data decorators" },
    { question: "How do you handle a stakeholder who wants the number they expected?", topic: "Communication", difficulty: "Medium", why: "Tests integrity under pressure" },
  ],
  aptitudeTopics: [
    { topic: "Data interpretation", weight: 30, tip: "Tables, charts, caselets - the core of analyst rounds" },
    { topic: "Quantitative aptitude", weight: 30, tip: "Percentages, ratios, averages, profit and loss" },
    { topic: "Logical reasoning", weight: 20, tip: "Sequencing, data sufficiency, puzzles" },
    { topic: "SQL practice", weight: 12, tip: "Joins, group-by, window functions on sample datasets" },
    { topic: "Verbal ability", weight: 8, tip: "Reading comprehension for case prompts" },
  ],
};

const PRODUCT: RoleProfile = {
  skills: [
    "User research & problem framing",
    "Prioritisation (impact vs effort, RICE)",
    "Metrics, funnels & experimentation",
    "Wireframing and writing crisp PRDs",
    "Stakeholder communication",
    "Competitive & market analysis",
  ],
  rounds: [
    { name: "Product sense round", focus: "Improve, design and prioritise for a real user" },
    { name: "Metrics / analytical round", focus: "Funnels, experiment design, reading data" },
    { name: "Execution round", focus: "Roadmaps, trade-offs, working with engineering" },
    { name: "Founder / HR round", focus: "Motivation, product taste and company fit" },
  ],
  questions: [
    { question: "Improve onboarding completion by 20% - walk me through your plan.", topic: "Product sense", difficulty: "Medium", why: "Shows structured problem solving with users in mind" },
    { question: "You have one week of team time - which of these two features do you ship?", topic: "Prioritisation", difficulty: "Medium", why: "Tests impact reasoning, not feature lists" },
    { question: "What metric would you put on a dashboard for this product and why?", topic: "Metrics", difficulty: "Medium", why: "Reveals whether you understand the business model" },
    { question: "Describe a product you dislike and how you would redesign it.", topic: "Product taste", difficulty: "Easy", why: "Surfaces observation habits and empathy" },
    { question: "Engineering says your request will take a month, not a week. What now?", topic: "Execution", difficulty: "Hard", why: "Tests negotiation without pulling rank" },
  ],
  aptitudeTopics: [
    { topic: "Quantitative aptitude", weight: 30, tip: "Percentages, ratios and sanity-check maths for metrics" },
    { topic: "Data interpretation", weight: 25, tip: "Funnels, cohorts and chart reading" },
    { topic: "Logical reasoning", weight: 25, tip: "Case logic, prioritisation puzzles" },
    { topic: "Verbal ability", weight: 20, tip: "Writing crisp one-pagers and RC speed" },
  ],
};

const BUSINESS: RoleProfile = {
  skills: [
    "Customer handling & objection pitching",
    "Market and competitor research",
    "Excel / reporting dashboards for your pipeline",
    "Written + spoken communication",
    "Negotiation and closing basics",
    "Domain knowledge of the industry you sell into",
  ],
  rounds: [
    { name: "HR / introductory round", focus: "Intro, motivation, location and notice period" },
    { name: "Functional / role-play round", focus: "Live pitch, objection handling or market case" },
    { name: "Hiring manager round", focus: "Targets, judgement and how you recover from a loss" },
  ],
  questions: [
    { question: "Pitch this company's product to a sceptical customer in 60 seconds.", topic: "Pitching", difficulty: "Medium", why: "Reveals clarity under pressure" },
    { question: "Your quarterly target is 20% above last quarter - what is your plan?", topic: "Targets", difficulty: "Medium", why: "Tests whether you break goals into actions" },
    { question: "A key account is about to churn. Walk me through the conversation.", topic: "Customer handling", difficulty: "Hard", why: "Shows empathy plus commercial judgement" },
    { question: "How would you research a market you have never sold into?", topic: "Market research", difficulty: "Medium", why: "Proves learning speed" },
    { question: "Tell me about a time you disagreed with a manager's approach.", topic: "Behavioural", difficulty: "Medium", why: "Surfaces communication style honestly" },
  ],
  aptitudeTopics: [
    { topic: "Quantitative aptitude", weight: 35, tip: "Percentages, profit and loss, ratios - the sales-maths core" },
    { topic: "Verbal ability", weight: 25, tip: "Email tone, comprehension and error spotting" },
    { topic: "Logical reasoning", weight: 20, tip: "Sequencing, seating arrangements, syllogisms" },
    { topic: "Data interpretation", weight: 20, tip: "Targets, tables and percentage-change charts" },
  ],
};

const HR: RoleProfile = {
  skills: [
    "Behavioural STAR storytelling",
    "Campus & stakeholder coordination",
    "Labour law & HR policy basics",
    "Sourcing and screening technique",
    "HR analytics basics (attrition, time-to-hire)",
    "Employee relations judgement",
  ],
  rounds: [
    { name: "HR / introductory round", focus: "Intro, motivation, location and notice period" },
    { name: "Behavioural panel", focus: "Conflict, confidentiality and judgement scenarios" },
    { name: "Functional round", focus: "Sourcing, screening and policy know-how" },
  ],
  questions: [
    { question: "An employee wants to report their own manager confidentially. How do you handle it?", topic: "Employee relations", difficulty: "Hard", why: "Tests confidentiality and process discipline" },
    { question: "How would you cut time-to-hire without lowering quality?", topic: "Recruiting ops", difficulty: "Medium", why: "Shows you understand the funnel" },
    { question: "Tell me about a time you delivered bad news to a candidate.", topic: "Behavioural", difficulty: "Medium", why: "Reveals empathy plus firmness" },
    { question: "How do you measure whether a hiring process is actually working?", topic: "HR analytics", difficulty: "Medium", why: "Separates operators from paperwork doers" },
    { question: "Why this company, from an HR point of view?", topic: "Motivation", difficulty: "Easy", why: "Checks basic research" },
  ],
  aptitudeTopics: [
    { topic: "Verbal ability", weight: 35, tip: "Comprehension, email drafting, error spotting" },
    { topic: "Logical reasoning", weight: 25, tip: "Sequencing, syllogisms, seating arrangements" },
    { topic: "Quantitative aptitude", weight: 25, tip: "Percentages, ratios and HR-metrics maths" },
    { topic: "Data interpretation", weight: 15, tip: "Attrition tables and percentage charts" },
  ],
};

const QA: RoleProfile = {
  skills: [
    "Test case design & coverage thinking",
    "Bug lifecycle and clear bug reports",
    "SQL for pulling test data",
    "API testing (Postman / REST)",
    "Automation basics (Selenium / Playwright)",
    "Regression strategy and release judgement",
  ],
  rounds: [
    { name: "Online test round", focus: "Aptitude plus test-design and SQL questions" },
    { name: "Technical round", focus: "Test cases, bug reporting, API and automation basics" },
    { name: "Hiring manager round", focus: "Release judgement, risk and working with developers" },
    { name: "HR round", focus: "Intro, motivation, location and notice period" },
  ],
  questions: [
    { question: "Write test cases for a login screen with password reset.", topic: "Test design", difficulty: "Medium", why: "Shows coverage thinking and edge cases" },
    { question: "A bug reproduces only in production. What do you do first?", topic: "Debugging", difficulty: "Medium", why: "Tests method under pressure" },
    { question: "How would you automate a flaky end-to-end flow?", topic: "Automation", difficulty: "Hard", why: "Reveals real automation experience" },
    { question: "Explain the difference between smoke, regression and sanity testing.", topic: "Fundamentals", difficulty: "Easy", why: "Baseline vocabulary check" },
    { question: "When would you NOT automate a test?", topic: "Judgement", difficulty: "Medium", why: "Proves you weigh cost, not just coverage" },
  ],
  aptitudeTopics: [
    { topic: "Quantitative aptitude", weight: 30, tip: "Percentages, ratios, time-speed-distance - the evergreen trio" },
    { topic: "Logical reasoning", weight: 25, tip: "Sequencing, syllogisms, defect-based puzzles" },
    { topic: "Programming basics", weight: 20, tip: "Arrays, strings, SQL fundamentals and time complexity" },
    { topic: "Verbal ability", weight: 15, tip: "Reading comprehension speed plus error spotting" },
    { topic: "Data interpretation", weight: 10, tip: "Tables, bar charts and approximation maths" },
  ],
};

const RULES: { test: RegExp; profile: RoleProfile }[] = [
  { test: /\b(quality|qa|test|testing|sdet|automation)\b/i, profile: QA },
  { test: /\b(hr|human resources?|recruiter|recruitment|talent)\b/i, profile: HR },
  { test: /\b(product|pm|product manager)\b/i, profile: PRODUCT },
  { test: /\b(data|analyst|analytics|scientist|bi|business intelligence|machine learning|ml)\b/i, profile: DATA },
  { test: /\b(software|developer|engineer|sde|devops|frontend|backend|full.?stack|programmer|architect)\b/i, profile: SOFTWARE },
  { test: /\b(sales|marketing|business|operations|account|finance|customer|support|associate|executive|development)\b/i, profile: BUSINESS },
];

/** Role keyword -> coaching profile. Empty role -> the honest generic path. */
export function roleProfile(role: string): RoleProfile {
  const r = role.trim();
  if (!r) return GENERIC;
  for (const rule of RULES) {
    if (rule.test.test(r)) return rule.profile;
  }
  return GENERIC;
}

/** Skills for this role (report role brief + plan fallback). [] with no role. */
export function roleSkills(role: string): string[] {
  return role.trim() ? roleProfile(role).skills : [];
}
