import { describe, expect, it } from 'vitest'
import { directTurnLeavesWorkOpen, isBareContinuation } from '../src/host/coordinator.js'

describe('enforced-v3 direct turns and bare continuations', () => {
  it.each(['Continue', 'Continue.', 'continue!', 'go on', 'keep going', '继续', '继续。', '请继续', '接着做'])(
    'treats %j as a bare continuation', (text: string) => {
      expect(isBareContinuation(text)).toBe(true)
    })

  it.each(['Continue the existing task.', 'Correct addition in calc.py.', 'Hello.', 'Continue. Also change the name.'])(
    'does not treat %j as a bare continuation', (text: string) => {
      expect(isBareContinuation(text)).toBe(false)
    })

  it('keeps an implementation request open when the Lead only plans', () => {
    expect(directTurnLeavesWorkOpen(
      ['Fix addition in calc.py and run test_calc.py. Do not stop after planning.'],
      'I will inspect calc.py and delegate the fix to Sidekick.',
    )).toBe(true)
    expect(directTurnLeavesWorkOpen(
      ['Correct addition in calc.py.'],
      'I will delegate the correction to Sidekick.',
    )).toBe(true)
    expect(directTurnLeavesWorkOpen(['Correct addition in calc.py.'], 'Done.')).toBe(true)
  })

  it('still allows a conversational answer', () => {
    expect(directTurnLeavesWorkOpen(['Hello.'], 'Hello.')).toBe(false)
    expect(directTurnLeavesWorkOpen(['What is 2 + 2?'], '4.')).toBe(false)
  })

  it('completes a definitional question that only mentions implementation words', () => {
    expect(directTurnLeavesWorkOpen(
      ['What does "implement" mean? Answer in one sentence.'],
      'It means to put a plan into practice.',
    )).toBe(false)
    expect(directTurnLeavesWorkOpen(
      ['What is a software patch? Answer in one sentence.'],
      'A patch is a set of changes applied to software.',
    )).toBe(false)
    expect(directTurnLeavesWorkOpen(
      ['What does implement mean in TypeScript?'],
      'It means to write the body of a declared function or interface.',
    )).toBe(false)
    expect(directTurnLeavesWorkOpen(
      ['Please explain what implement means.'],
      'It means to put a design into code.',
    )).toBe(false)
    expect(directTurnLeavesWorkOpen(
      ['软件补丁是什么？'],
      '软件补丁是一组应用到程序上的改动。',
    )).toBe(false)
    expect(directTurnLeavesWorkOpen(
      ['实现是什么意思？'],
      '实现就是把设计写成可以运行的代码。',
    )).toBe(false)
    expect(directTurnLeavesWorkOpen(
      ['What does a patch in calc.py mean?'],
      'It is a file of changes applied to that program.',
    )).toBe(false)
  })

  it('keeps a mixed definition and workspace command open', () => {
    expect(directTurnLeavesWorkOpen(
      ['What is a software patch? Then fix it in calc.py.'],
      'A patch is a diff. Done.',
    )).toBe(true)
    expect(directTurnLeavesWorkOpen(
      ['补丁是什么？请修复 calc.py。'],
      'Done.',
    )).toBe(true)
  })

  it('keeps a planning or deferral reply open even for a definitional question', () => {
    expect(directTurnLeavesWorkOpen(['Hello.'], "First I'll check the files.")).toBe(true)
    expect(directTurnLeavesWorkOpen(['What is a software patch?'], 'Let me read the repo and explore the definition.')).toBe(true)
    expect(directTurnLeavesWorkOpen(['What does implement mean?'], "I'll check the files and delegate the write.")).toBe(true)
    expect(directTurnLeavesWorkOpen(['软件补丁是什么？'], '我先去查看相关代码。')).toBe(true)
    expect(directTurnLeavesWorkOpen(['Hello.'], '接下来我会检查实现。')).toBe(true)
  })
})

const directCases = [
  { id: 'en-implement-exact', prompt: 'What does "implement" mean? Answer in one sentence.', reply: 'It means to put a plan into practice.' },
  { id: 'en-patch-exact', prompt: 'What is a software patch? Answer in one sentence.', reply: 'A patch is a set of changes applied to software.' },
  { id: 'en-implement-typescript', prompt: 'What does implement mean in TypeScript?', reply: 'It means to write the body of a declared function or interface.' },
  { id: 'en-fix-definition', prompt: 'What does "fix" mean in software development?', reply: 'It means to correct a defect in a program.' },
  { id: 'en-test-definition', prompt: 'What is a unit test?', reply: 'A unit test checks a small part of a program against an expected result.' },
  { id: 'en-refactor-definition', prompt: 'What does refactor mean?', reply: 'It means to restructure code while preserving its behavior.' },
  { id: 'en-run-tests-definition', prompt: 'What does "run tests" mean?', reply: 'It means to execute automated checks and inspect their results.' },
  { id: 'en-patch-explanation', prompt: 'Explain what a software patch does.', reply: 'It applies a set of changes to an existing program.' },
  { id: 'en-run-tests-explanation', prompt: 'Explain how to run tests without changing any files.', reply: 'Execute the project test command and read its results; this explanation does not change files.' },
  { id: 'en-implement-how', prompt: 'How do I implement a TypeScript interface? Please explain only; do not edit any files.', reply: 'Declare a class with implements and provide each required member.' },
  { id: 'en-patch-how', prompt: 'How does a software patch work? Explain only, without editing files.', reply: 'It describes the differences between two versions so a tool can apply those differences.' },
  { id: 'en-test-why', prompt: 'Why do we run tests? Please answer conceptually without executing anything.', reply: 'Tests reveal behavior that differs from the expected result.' },
  { id: 'zh-patch-definition', prompt: '软件补丁是什么？', reply: '软件补丁是一组应用到程序上的改动。' },
  { id: 'zh-implement-definition', prompt: '实现是什么意思？', reply: '实现就是把设计写成可以运行的代码。' },
  { id: 'zh-fix-definition', prompt: '修复是什么意思？', reply: '修复就是纠正程序中的错误。' },
  { id: 'zh-test-definition', prompt: '什么是单元测试？', reply: '单元测试用预期结果检查一小段程序的行为。' },
  { id: 'zh-run-tests-prefix-definition', prompt: '运行测试是什么意思？', reply: '运行测试就是执行已有的检查并查看结果。' },
  { id: 'zh-run-tests-suffix-definition', prompt: '什么是运行测试？', reply: '运行测试就是执行已有的检查并查看结果。' },
  { id: 'zh-refactor-definition', prompt: '怎么理解重构？', reply: '重构是在保留行为的前提下调整代码结构。' },
  { id: 'zh-fix-explanation', prompt: '解释一下如何修复程序中的错误，只讲原理，不要修改文件。', reply: '先定位错误原因，再修改导致错误的逻辑，最后用测试验证预期行为。' },
  { id: 'zh-implement-how', prompt: '如何实现一个接口？只解释概念，不改文件。', reply: '声明一个符合接口约定的类型，并提供接口要求的成员。' },
  { id: 'zh-tests-explanation', prompt: '请解释如何运行测试，不要实际执行命令。', reply: '使用项目文档指定的测试命令，并检查退出码和测试结果。' },
] as const

const blockedCases = [
  { id: 'plan-en-original', prompt: 'Fix addition in calc.py and run test_calc.py. Do not stop after planning.', reply: 'I will inspect calc.py and delegate the fix to Sidekick.' },
  { id: 'plan-zh-original', prompt: '修复 calc.py 中的 addition，并运行测试。不要只做计划。', reply: '接下来我会去查看 calc.py，然后把修复交给 Sidekick。' },
  { id: 'plan-zh-question', prompt: '软件补丁是什么？', reply: '接下来我会去查看相关代码，然后回答。' },
  { id: 'plan-en-question', prompt: 'What is a software patch?', reply: 'Let me read the repo and explore the definition.' },
  { id: 'unexecuted-fix', prompt: 'Fix addition in calc.py.', reply: 'Done.' },
  { id: 'unexecuted-implement', prompt: 'Implement addition in calc.py.', reply: 'Done.' },
  { id: 'unexecuted-patch', prompt: 'Patch calc.py to correct addition.', reply: 'Done.' },
  { id: 'unexecuted-tests', prompt: 'Run tests for calc.py.', reply: 'Done.' },
  { id: 'unexecuted-zh-fix', prompt: '修复 calc.py 中的 addition。', reply: '已处理。' },
  { id: 'unexecuted-zh-implement', prompt: '请实现 calc.py 中的 addition。', reply: '已处理。' },
  { id: 'unexecuted-zh-tests', prompt: '请运行测试。', reply: '已处理。' },
  { id: 'mixed-en-then-fix', prompt: 'What is a software patch? Then fix addition in calc.py.', reply: 'A patch is a set of changes applied to software.' },
  { id: 'mixed-zh-separate', prompt: '补丁是什么？请修复 calc.py 中的 addition。', reply: '补丁是一组应用到程序上的改动。' },
  { id: 'mixed-en-and-fix', prompt: 'Explain what a software patch is and fix addition in calc.py.', reply: 'A patch is a set of changes applied to software.' },
  { id: 'mixed-en-then-patch', prompt: 'Explain what a software patch is, then patch calc.py to fix addition.', reply: 'A patch is a set of changes applied to software.' },
  { id: 'mixed-en-define-implement', prompt: 'Explain what implement means and implement addition in calc.py.', reply: 'Implement means to put a plan into code.' },
  { id: 'mixed-zh-and-fix', prompt: '请解释补丁是什么，并修复 calc.py 中的 addition。', reply: '补丁是一组应用到程序上的改动。' },
  { id: 'mixed-zh-and-implement', prompt: '请解释什么是实现，并实现 calc.py 中的 addition。', reply: '实现就是把设计写成代码。' },
] as const

describe('validator direct conversation matrix', () => {
  it.each(directCases)('completes answered explanation $id', ({ prompt, reply }: { prompt: string; reply: string }) => {
    expect(directTurnLeavesWorkOpen([prompt], reply)).toBe(false)
  })
})

describe('validator premature completion matrix', () => {
  it.each(blockedCases)('keeps unexecuted or planning request open $id', ({ prompt, reply }: { prompt: string; reply: string }) => {
    expect(directTurnLeavesWorkOpen([prompt], reply)).toBe(true)
  })
})
