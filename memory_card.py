
# создай приложение для запоминания информации
from PyQt5.QtCore import Qt
from PyQt5.QtWidgets import QApplication, QVBoxLayout, QHBoxLayout, QLabel, QRadioButton, QGroupBox, QWidget, QPushButton, QButtonGroup
from random import *

class Question():
    def __init__(self, main_question, right_answer, wrong1, wrong2, wrong3):
        self.main_question = main_question
        self.right_answer = right_answer
        self.wrong1 = wrong1
        self.wrong2 = wrong2
        self.wrong3 = wrong3

def show_result():
    RadioGroupBox.hide()
    AnsGroupBox.show()
    btn.setText('Следующий вопрос')

def show_question():
    RadioGroupBox.show()
    AnsGroupBox.hide()
    btn.setText('Ответить')
    RadioGroup.setExclusive(False)
    rbtn1.setChecked(False)
    rbtn2.setChecked(False)
    rbtn3.setChecked(False)
    rbtn4.setChecked(False)
    RadioGroup.setExclusive(True)

def start_test():
    if btn.text() == 'Ответить':
        show_result()
    if btn.text() == 'Следующий вопрос':
        show_question()

def ask(q):
    shuffle(answers)
    answers[0].setText(q.right_answer)
    answers[1].setText(q.wrong1)
    answers[2].setText(q.wrong2)
    answers[3].setText(q.wrong3)
    question.setText(q.main_question)
    result.setText(q.right_answer)
    show_question()

question_list = []
question_list.append(
    Question('Государственный язык Португалии', 'Португальский', 'Английский', 'Испанский', 'Французский')
)

question_list.append(
    Question('Государственный язык Бразилии', 'Португальский', 'Итальянский', 'Немецкий', 'Бразильский')
)


question_list.append(
    Question('Когды был создан первый в мире 3d принтер', '2012', '2004', '2016', '2020')
)

question_list.append(
    Question('Какая глубина у марианской впадины в километрах', '11', '14', '7', '10')
)

question_list.append(
    Question('Сколько дней в високосном году?', '366','354','355','271')
)




def next_question():
    main_win.total += 1  # Исправлено: убрали скобки и добавили инкремент
    print('Статистика\n-Всего вопросов:', main_win.total, '\n-Правильных ответов:', main_win.score)  # Исправлено: закрыты кавычки и скобки
    cur_question = randint(0, len(question_list) - 1)
    q = question_list[cur_question]
    ask(q)

def click_OK():
    if btn.text() == 'Ответить':
        check_answer()
    else:
        next_question()

def check_answer():
    if answers[0].isChecked():
        show_correct('Правильно')
        main_win.score += 1  # Перенесено сюда, чтобы увеличивать счетчик только при правильном ответе
    elif answers[1].isChecked() or answers[2].isChecked() or answers[3].isChecked():
        show_correct('Неправильно!')
    
    print('Статистика\n-Всего вопросов:', main_win.total, '\n-Правильных ответов:', main_win.score)  # Исправлено: закрыты кавычки
    rating = (main_win.score / main_win.total * 100) if main_win.total > 0 else 0  # Исправлено: правильное вычисление рейтинга
    print('Рейтинг:', round(rating, 1), '%')  # Исправлено: правильный синтаксис

def show_correct(res):
    answer.setText(res)
    show_result()

app = QApplication([])
main_win = QWidget()
main_win.setWindowTitle('Memory Card')
main_win.resize(300, 200)

question = QLabel('Какой национальности не существует?')
btn = QPushButton('Ответить')

RadioGroupBox = QGroupBox('Варианты ответов')
rbtn1 = QRadioButton('Энцы')
rbtn2 = QRadioButton('Чулымцы')
rbtn3 = QRadioButton('Смурфы')
rbtn4 = QRadioButton('Алеуты')

RadioGroup = QButtonGroup()
RadioGroup.addButton(rbtn1)
RadioGroup.addButton(rbtn2)
RadioGroup.addButton(rbtn3)
RadioGroup.addButton(rbtn4)

layout_ans1 = QVBoxLayout()
layout_ans2 = QHBoxLayout()
layout_ans3 = QHBoxLayout()

layout_ans2.addWidget(rbtn1)
layout_ans2.addWidget(rbtn2)
layout_ans3.addWidget(rbtn3)
layout_ans3.addWidget(rbtn4)

layout_ans1.addLayout(layout_ans2)
layout_ans1.addLayout(layout_ans3)
RadioGroupBox.setLayout(layout_ans1)

AnsGroupBox = QGroupBox('Результат Теста')
answer = QLabel('Правильно/Неправильно')
result = QLabel('Правильный ответ')

layout_result = QVBoxLayout()
layout_result.addWidget(answer, alignment=Qt.AlignLeft)
layout_result.addWidget(result, alignment=Qt.AlignCenter)
AnsGroupBox.setLayout(layout_result)

layout_line1 = QHBoxLayout()
layout_line2 = QHBoxLayout()
layout_line3 = QHBoxLayout()

layout_line1.addWidget(question, alignment=Qt.AlignCenter)
layout_line2.addWidget(RadioGroupBox)
layout_line2.addWidget(AnsGroupBox)

layout_line3.addStretch(1)
layout_line3.addWidget(btn, stretch=4)
layout_line3.addStretch(1)

main_layout = QVBoxLayout()
main_layout.addLayout(layout_line1, stretch=2)
main_layout.addLayout(layout_line2, stretch=4)
main_layout.addLayout(layout_line3)

main_win.setLayout(main_layout)

btn.clicked.connect(click_OK)

answers = [rbtn1, rbtn2, rbtn3, rbtn4]

main_win.total = 0
main_win.score = 0

next_question()

RadioGroupBox.show()
AnsGroupBox.hide()

main_win.show()
app.exec_()
