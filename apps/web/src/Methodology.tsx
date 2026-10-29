import { comparePrompt } from "@parsejudge/core/prompt";
import { type ReactNode, useEffect, useState } from "react";
import { currentUser } from "./api.ts";
import { BlindRequestFigure, SampleSizeFigure, SubsetFigure } from "./figures.tsx";
import { Nav } from "./Nav.tsx";

const SECTIONS = [
  ["why", "Why your own documents"],
  ["scored", "What is scored"],
  ["judge", "Why a model judge"],
  ["run", "How a run works"],
  ["output", "What the judge returns"],
  ["rule", "A short scoring rule"],
  ["report", "What a report shows"],
  ["review", "Checking the judge"],
  ["limits", "Limits"],
  ["data", "Data handling"],
  ["prompt", "Judge prompt"],
] as const;

const Section = ({ id, children }: { readonly id: (typeof SECTIONS)[number][0]; readonly children: ReactNode }) => (
  <section id={id}>
    <h2>{SECTIONS.find(([s]) => s === id)?.[1]}</h2>
    {children}
  </section>
);

const useActive = () => {
  const [active, setActive] = useState<string>(SECTIONS[0][0]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const [id] of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  return active;
};

export const Methodology = () => {
  const active = useActive();
  useEffect(() => {
    document.title = "Methodology · Parse Judge";
    return () => {
      document.title = "Parse Judge";
    };
  }, []);
  return (
    <div>
      <Nav user={currentUser()} active="methodology" />
      <header className="article-head">
        <h1>How Parse Judge scores document parsers</h1>
        <p>
          Parse Judge runs parsers on your documents, renders every page to one image, and asks a vision-language model to grade
          all outputs for that page in one blind request. This page describes the procedure, what the scores mean, and where they
          stop being reliable.
        </p>
      </header>
      <div className="article-wrap">
        <nav className="toc wide-only" aria-label="Contents">
          {SECTIONS.map(([id, title]) => (
            <a key={id} href={`#${id}`} aria-current={active === id ? "true" : undefined}>
              {title}
            </a>
          ))}
        </nav>
        <article className="article">
          <Section id="why">
            <p>
              Published benchmarks use different document sets, different definitions of a correct output, and different settings
              for the systems they test. A result from one benchmark supports conclusions about that benchmark. It says less about
              your documents.
            </p>
            <p>
              Two problems are hard to see from a published number. The first is subset selection. A development run may cover
              1,000 candidate pages while the release contains 100. A smaller release is not a problem in itself. Choosing it
              after the scores are known is. The score then describes the chosen pages, and a reader cannot tell from the release
              how they were chosen.
            </p>
            <SubsetFigure />
            <p>
              The second is sensitivity to small changes in the files. White padding or a slight rotation leaves the reading task
              unchanged for a person, but has produced large score drops on public benchmarks, including for the benchmark
              author's own system. A drop of that size shows that part of the score belonged to the exact files.
            </p>
            <p>
              Shared benchmarks are still useful for screening and regression tests. A purchase or deployment decision needs more:
              a sample from the documents the parser will process, fixed before scoring, graded blind, with every exclusion
              reported.
            </p>
          </Section>

          <Section id="scored">
            <p>
              The score measures information preservation: how much of the visible content of the page, and of the relations
              within it, can be recovered from the output. Relations include table cells to rows and columns, labels to values,
              checkbox states, and reading order. Omitted content is an error. Content that is not on the page is an error.
            </p>
            <p>
              Syntax gets no credit of its own. A table may be Markdown or HTML, a checked box a symbol or a word, an empty field
              blank or an explicit marker. Each is scored on the information it carries.
            </p>
          </Section>

          <Section id="judge">
            <p>
              Human transcription of a test set is costly, and it forces a choice of reference syntax before scoring. Exact
              matching against one reference then measures agreement with that reference, not preservation of information.
            </p>
            <p>
              Current vision-language models read page images well enough to check a parse that already exists. The judge gets the
              image and the outputs and reports where they disagree: omitted text, invented values, wrong cells, wrong checkbox
              states, wrong order. Checking needs no reference syntax, and every reported error can be verified against the image.
            </p>
            <p>
              A large model may be too slow or expensive to run on every production page. Evaluation covers a fixed sample, so the
              judge is paid for on sample pages only. Its accuracy still has to be checked for each document type (see{" "}
              <a href="#review">Checking the judge</a>). Scores are judge scores under a stated model and prompt.
            </p>
          </Section>

          <Section id="run">
            <ol>
              <li>
                <b>Fix the sample.</b> Choose the pages before any parser runs. Record the sampling rule and every later exclusion
                with its reason. Do not drop a page because a parser did badly on it.
              </li>
              <li>
                <b>Render.</b> DOCX and PPTX are converted to PDF. Each page is rendered once with PDFium at 200 DPI, at most
                2,400 px on the long side. Every parser and the judge get the same PNG.
              </li>
              <li>
                <b>Parse.</b> Each parser runs once per page with fixed settings, and its raw response is saved. Latency runs from
                submit until the result is available. Time spent waiting for a Parse Judge concurrency slot is tracked separately.
                An error or timeout is a failed parse.
              </li>
              <li>
                <b>Convert.</b> Each response becomes one Markdown string per page, in reading order. Tables stay in the form the
                parser returned.
              </li>
              <li>
                <b>Judge.</b> One request per page carries the image and every successful parse under blind labels. Provider
                names, file names and settings are not sent.
              </li>
              <li>
                <b>Validate.</b> The response must match a fixed JSON schema: every label scored once, integer scores from 1 to
                10. Invalid responses are retried. A page with no valid response is recorded as a judge failure.
              </li>
            </ol>
            <BlindRequestFigure />
            <p>
              A run uses one judge model, one reasoning setting, one prompt version and one schema for every page and every
              parser. All of them are stored on the run and shown at the bottom of its report.
            </p>
          </Section>

          <Section id="output">
            <p>
              For each output the judge lists errors first, then scores. Each error has a severity, one of 17 categories, a region
              type, a location on the page, and a one-sentence description that quotes the page text and what the parse wrote
              instead. Categories name the visible defect, not a cause inside the parser.
            </p>
            <dl className="severity">
              <dt>
                <span className="tag high">high</span>
              </dt>
              <dd>
                Removes information needed to use the page, or supplies false information: an omitted section, an invented value,
                a value under the wrong label, broken reading order.
              </dd>
              <dt>
                <span className="tag">medium</span>
              </dt>
              <dd>A real error whose correct reading can usually be inferred from context.</dd>
              <dt>
                <span className="tag low">low</span>
              </dt>
              <dd>Affects form only. Meaning and recovery are unchanged.</dd>
            </dl>
            <p>
              Scores run from 1 (empty or largely wrong) to 10 (no errors found) and must agree with the error list. A
              high-severity error keeps a score well below 10. Low-severity errors alone can still score 9 or 10. The judge also
              tags the page itself, for example table, form or handwriting, independently of any output.
            </p>
            <p>
              All outputs for a page are graded in one request against one image, so every score for that page comes from the same
              reading of it. Grading each parser in a separate request would let that reading vary between parsers.
            </p>
          </Section>

          <Section id="rule">
            <p>
              The prompt defines a correct parse in a few lines rather than in a long format specification. A long specification
              would mix two things in one score, information loss and compliance with a chosen syntax, and real documents always
              contain elements it did not anticipate. The short rule asks the same question of every page: did the information
              survive, and can a reader recover it?
            </p>
            <p>Five cases get explicit rules, because the image alone leaves them ambiguous:</p>
            <ul>
              <li>Page text is copied as shown. Matching an unusual spelling is correct. Correcting it is an error.</li>
              <li>
                Markers for empty values, checkbox states, signatures, redactions or illegible text are accepted when they
                describe the visible state correctly.
              </li>
              <li>A figure or chart description is graded on whether it agrees with the image, not penalized for existing.</li>
              <li>Link targets from PDF metadata are neutral whether present or absent. Visible link text is graded.</li>
              <li>
                Whitespace, apostrophe style and repeated list markers are ignored when content, order and list structure are
                unchanged.
              </li>
            </ul>
          </Section>

          <Section id="report">
            <p>For each parser, over the pages with a valid judge response:</p>
            <ul>
              <li>mean and median score;</li>
              <li>page-by-page wins, ties and losses against each other parser, where a failed parse counts as 1;</li>
              <li>share of pages with at least one high-severity error, with a 95% Wilson interval;</li>
              <li>error counts by category, and failed pages;</li>
              <li>latency p50 and p95, list price per 1,000 pages, and price against mean score.</li>
            </ul>
            <p>
              Scores, head-to-head outcomes and error rates carry the comparison. Error counts are secondary, because the judge
              may report one defect as one error or as several. Small samples support limited conclusions: treat a run of fewer
              than about 100 pages as a check of the pipeline.
            </p>
            <SampleSizeFigure />
            <p>
              Two reporting rules follow from the problems at the top of this page. First, report the full sample: pages sampled,
              pages excluded and why, pages scored, and pages lost to parser or judge failure. Second, where the decision matters,
              run a robustness check. Apply a change a reader would ignore, such as white padding or a small rotation, to a fixed
              subset, rerun it, and report it separately. A score that holds says something about documents in general. A score
              that falls says something about those files.
            </p>
          </Section>

          <Section id="review">
            <p>
              Before a run is used for a decision, compare the judge with human grades. Review the pages where judge error is most
              likely to change a conclusion:
            </p>
            <ul>
              <li>pages where parser scores differ by 3 or more;</li>
              <li>pages scored 5 or lower;</li>
              <li>pages with a high-severity error;</li>
              <li>a random 10% of pages where every parser scored 8 or higher.</li>
            </ul>
            <p>
              The clean pages matter as much as the flagged ones. Flagged pages show whether reported errors are real. Clean pages
              show whether errors were missed. Every error quotes both texts, so a reviewer checks a claim instead of reading a
              page from scratch.
            </p>
            <p>
              Look at agreement by page type, since a judge can be accurate on prose and weak on dense tables. If disagreement
              follows a pattern, change the prompt or the judge model and regrade every page. Do not edit scores by hand. A
              hand-corrected dataset comes from no single grading rule and cannot be rerun.
            </p>
          </Section>

          <Section id="limits">
            <ul>
              <li>
                The unit is a page. Tables that continue across pages, cross-page reading order and repeated headers are measured
                only in part.
              </li>
              <li>The judge grades Markdown. Bounding boxes and block metadata are not scored.</li>
              <li>
                The judge sees a PNG of at most 2,400 px on the long side. Very small type may be hard to read, so check dense
                pages during review.
              </li>
              <li>
                A judge can share failure modes with a parser built on a similar model, and blinding hides names but not style.
                For a close comparison, repeat the run with a second judge model.
              </li>
              <li>
                Scores are ordered categories. A drop from 9 to 8 is not known to equal a drop from 5 to 4, which is why the
                median, head-to-head and error rates are reported with the mean.
              </li>
              <li>
                Judge failures are outside the scored set. If they cluster on hard pages, scores are optimistic. Failure counts
                are in the report.
              </li>
              <li>
                Runs are comparable only when the sample, judge model, prompt, schema and parser settings are the same, or the
                changes are stated.
              </li>
              <li>
                Latency is wall-clock time during one run, including network and vendor queueing. It is not a service level.
              </li>
            </ul>
          </Section>

          <Section id="data">
            <ul>
              <li>
                Documents go only to the parsers selected for the run and to the judge model provider. After judging, a smaller
                model writes page summaries and locates quoted errors in the output. It does not change scores.
              </li>
              <li>Your own API keys are encrypted, used only for that run, and deleted when it ends.</li>
              <li>
                Reports can be private or shared by link. Documents, reports and all account data can be deleted from Settings.
              </li>
              <li>Check each provider's data terms before you upload restricted documents.</li>
            </ul>
            <p>
              A parser is added through an adapter with a small contract: accept a page, save the raw response, and return
              Markdown. Providers are welcome to correct their own settings and prices. An evaluation that grades an old model or
              a wrong price helps nobody.
            </p>
          </Section>

          <Section id="prompt">
            <p>
              This is the prompt the judge receives, exactly as the code sends it. <code>{"{parse_sections}"}</code> holds one
              section per blind label, in label order, each with the label as a heading and that parse's Markdown in a fenced
              block. <code>{"{labels}"}</code> holds the labels joined by a comma and a space, for example{" "}
              <code>parse_a, parse_b</code>.
            </p>
            <details className="prompt">
              <summary>Show the judge prompt</summary>
              <pre>{comparePrompt("{parse_sections}", "{labels}")}</pre>
            </details>
          </Section>
        </article>
      </div>
    </div>
  );
};
