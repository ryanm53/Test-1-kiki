// Canvas "Classic Quizzes" markup, as served on /courses/:id/quizzes/:id/take.
// Structure follows Canvas's _display_question template: question text in
// .question_text, each choice an input with a <label for>, all questions on
// one page by default. data-top fakes the vertical layout jsdom lacks, so the
// page can be taller than the window like the real thing.
const q = (n, top, type, text, choices) => {
  const kind = type === 'checkbox' ? 'multiple_answers_question'
             : choices.length === 2 ? 'true_false_question' : 'multiple_choice_question';
  return `
  <div role="region" aria-label="Question" class="quiz_sortable question_holder" data-top="${top}">
    <div class="display_question question ${kind}" id="question_${n}">
      <div class="header">
        <span class="name question_name" role="heading" aria-level="2">Question ${n - 100}</span>
        <span class="question_points_holder"><span class="points question_points">1</span> pts</span>
      </div>
      <div id="question_${n}_question_text" class="question_text user_content"><p>${text}</p></div>
      <div class="answers"><fieldset class="answers_wrapper"><legend class="screenreader-only">Answers</legend>
        ${choices.map((c, i) => `
        <div class="answer">
          <div class="select_answer answer_type">
            <input type="${type}" class="question_input" name="question_${n}${type === 'checkbox' ? '_' + i : ''}"
                   id="question_${n}_answer_${i}" value="${i}">
            <label for="question_${n}_answer_${i}"><div class="answer_label">${c}</div></label>
          </div>
        </div>`).join('')}
      </fieldset></div>
    </div>
  </div>`;
};

const ALL_ON_ONE_PAGE = `<body>
<div id="content" class="ic-Layout-contentMain" role="main">
  <div id="quiz_show" data-top="0">
    <h1 id="quiz_title">Chapter 3 Quiz</h1>
    <div class="description user_content">
      <p>This quiz covers chapter 3: the accounting equation, assets, liabilities and equity.
      You have one attempt and 30 minutes. Answer every question, then press Submit Quiz at
      the bottom of the page. Late submissions are not accepted. Read each question carefully
      before answering, and remember that some questions have more than one correct answer.
      Academic integrity policy applies: this is individual work.</p>
    </div>
  </div>
  <form id="submit_quiz_form" action="/courses/1/quizzes/2/submissions" method="post">
    <div id="questions" class="assessing">
      ${q(101,  300, 'radio', 'Which of the following is an asset?', ['Accounts payable', 'Cash', 'Common stock', 'Revenue'])}
      ${q(102,  700, 'radio', 'Liabilities are obligations owed to creditors.', ['True', 'False'])}
      ${q(103, 1100, 'radio', 'The accounting equation is:', ['Assets = Liabilities + Equity', 'Assets = Revenue - Expenses', 'Equity = Assets + Liabilities', 'Liabilities = Assets + Equity'])}
      ${q(104, 1500, 'checkbox', 'Select all that are liabilities.', ['Notes payable', 'Inventory', 'Unearned revenue', 'Equipment'])}
    </div>
    <div class="form-actions" data-top="1900">
      <button type="submit" class="btn btn-primary submit_button quiz_submit" id="submit_quiz_button">Submit Quiz</button>
    </div>
  </form>
</div>
<div id="right-side" data-top="0">
  <h2>Questions</h2>
  <ul id="question_list">
    <li><a href="#question_101">Question 1</a></li><li><a href="#question_102">Question 2</a></li>
    <li><a href="#question_103">Question 3</a></li><li><a href="#question_104">Question 4</a></li>
  </ul>
  <div class="time_running">Time Running: 2 Minutes, 14 Seconds</div>
</div>
</body>`;

// "Show one question at a time": a single question and Previous/Next buttons
const ONE_AT_A_TIME = `<body>
<div id="content" class="ic-Layout-contentMain" role="main">
  <form id="submit_quiz_form" action="/courses/1/quizzes/2/submissions" method="post">
    <div id="questions" class="assessing one_question_at_a_time">
      ${q(102, 200, 'radio', 'Liabilities are obligations owed to creditors.', ['True', 'False'])}
    </div>
    <div class="button-container" data-top="600">
      <button type="button" class="btn submit_button previous-question">Previous</button>
      <button type="button" class="btn submit_button next-question">Next</button>
    </div>
    <div class="form-actions" data-top="700">
      <button type="submit" class="btn btn-primary submit_button quiz_submit" id="submit_quiz_button">Submit Quiz</button>
    </div>
  </form>
</div>
</body>`;

// Stub layout from data-top: each element sits at its nearest data-top ancestor
function installLayout(w) {
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const host = this.closest('[data-top]');
    const top = (host ? Number(host.dataset.top) : 10) - (w.__scrollY ?? 0);
    return { width: 120, height: 20, top, bottom: top + 20, left: 20, right: 140 };
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
}

module.exports = { ALL_ON_ONE_PAGE, ONE_AT_A_TIME, installLayout };
