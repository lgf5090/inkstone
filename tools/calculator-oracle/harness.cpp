#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <memory>
#include <locale>
#include <codecvt>
#include "CalculatorManager.h"
#include "CalculatorResource.h"
#include "Command.h"
#include "ExpressionCommandInterface.h"

using namespace CalculationManager;

namespace
{
    std::string W(const std::wstring& text)
    {
        static std::wstring_convert<std::codecvt_utf8<wchar_t>> converter;
        std::string value = converter.to_bytes(text);
        for (char& ch : value)
        {
            if (ch == '\t' || ch == '\n' || ch == '\r')
            {
                ch = ' ';
            }
        }
        return value;
    }

    std::wstring engineString(int id)
    {
        switch (id)
        {
        case 2: return L"CE";
        case 4: return L".";
        case 6: return L"AND";
        case 7: return L"OR";
        case 8: return L"XOR";
        case 9: return L"Lsh";
        case 10: return L"Rsh";
        case 11: return L"\u00F7";
        case 12: return L"\u00D7";
        case 13: return L"+";
        case 14: return L"-";
        case 15: return L"Mod";
        case 16: return L"yroot";
        case 17: return L"^";
        case 18: return L"Int";
        case 19: return L"RoL";
        case 20: return L"RoR";
        case 21: return L"NOT";
        case 22: return L"sin";
        case 23: return L"cis";
        case 24: return L"tan";
        case 25: return L"sinh";
        case 26: return L"cosh";
        case 27: return L"tanh";
        case 28: return L"ln";
        case 29: return L"log";
        case 30: return L"\u221A";
        case 35: return L"dms";
        case 37: return L"10^";
        case 38: return L"%";
        case 40: return L"Pi";
        case 41: return L"=";
        case 47: return L"Exp";
        case 48: return L"(";
        case 49: return L")";
        case 66: return L"frac";
        case 67: return L"sin\u2080";
        case 68: return L"cos\u2080";
        case 69: return L"tan\u2080";
        case 70: return L"sin\u2080\u207B\u00B9";
        case 71: return L"cos\u2080\u207B\u00B9";
        case 72: return L"tan\u2080\u207B\u00B9";
        case 73: return L"sin\u1D63";
        case 74: return L"cos\u1D63";
        case 75: return L"tan\u1D63";
        case 76: return L"sin\u1D63\u207B\u00B9";
        case 77: return L"cos\u1D63\u207B\u00B9";
        case 78: return L"tan\u1D63\u207B\u00B9";
        case 79: return L"sin\u2089";
        case 80: return L"cos\u2089";
        case 81: return L"tan\u2089";
        case 82: return L"sin\u2089\u207B\u00B9";
        case 83: return L"cos\u2089\u207B\u00B9";
        case 84: return L"tan\u2089\u207B\u00B9";
        case 85: return L"sinh\u207B\u00B9";
        case 86: return L"cosh\u207B\u00B9";
        case 87: return L"tanh\u207B\u00B9";
        case 88: return L"e^";
        case 89: return L"10^";
        case 90: return L"\u221A";
        case 91: return L"sqr";
        case 92: return L"cube";
        case 94: return L"fact";
        case 95: return L"1/";
        case 96: return L"degrees";
        case 97: return L"negate";
        case 99: return L"Cannot divide by zero";
        case 100: return L"Invalid input";
        case 101: return L"Result is undefined";
        case 105: return L"Not enough memory";
        case 107: return L"Overflow";
        case 108: return L"Result not defined";
        case 118: return L"Result not defined";
        case 119: return L"Overflow";
        case 120: return L"Overflow";
        default: return std::to_wstring(id);
        }
    }

    struct Display final : ICalcDisplay
    {
        std::wstring primary = L"0";
        std::wstring expression;
        std::wstring tokenDump;
        bool error = false;
        int maxDigits = 0;
        int binaryOperators = 0;
        int historyAdded = 0;
        unsigned int parenthesisCount = 0;
        std::vector<std::wstring> memory;

        void SetPrimaryDisplay(const std::wstring& text, bool isError) override
        {
            primary = text;
            error = isError;
        }
        void SetIsInError(bool isError) override { error = isError; }
        void SetExpressionDisplay(
            std::shared_ptr<std::vector<std::pair<std::wstring, int>>> const& tokens,
            std::shared_ptr<std::vector<std::shared_ptr<IExpressionCommand>>> const&) override
        {
            expression.clear();
            tokenDump.clear();
            if (!tokens)
            {
                return;
            }
            for (const auto& token : *tokens)
            {
                if (!expression.empty())
                {
                    expression += L" ";
                }
                expression += token.first;
                if (!tokenDump.empty())
                {
                    tokenDump += L"|";
                }
                tokenDump += L"[";
                tokenDump += token.first;
                tokenDump += L"]";
            }
        }
        void SetParenthesisNumber(unsigned int count) override { parenthesisCount = count; }
        void OnNoRightParenAdded() override {}
        void MaxDigitsReached() override { maxDigits++; }
        void BinaryOperatorReceived() override { binaryOperators++; }
        void OnHistoryItemAdded(unsigned int) override { historyAdded++; }
        void SetMemorizedNumbers(const std::vector<std::wstring>& numbers) override { memory = numbers; }
        void MemoryItemChanged(unsigned int) override {}
        void InputChanged() override {}
    };

    struct Resources final : IResourceProvider
    {
        std::wstring GetCEngineString(std::wstring_view id) override
        {
            const std::wstring value(id);
            if (value == L"sDecimal") return L".";
            if (value == L"sThousand") return L",";
            if (value == L"sGrouping") return L"3;0";
            if (value == L"sDecimalSeparator") return L".";
            if (value == L"sThousandSeparator") return L",";
            try
            {
                return engineString(std::stoi(value));
            }
            catch (...)
            {
                return value;
            }
        }
    };

    std::vector<int> parseCommands(const std::string& text)
    {
        std::vector<int> commands;
        std::stringstream stream(text);
        std::string item;
        while (std::getline(stream, item, ','))
        {
            if (!item.empty())
            {
                commands.push_back(std::stoi(item));
            }
        }
        return commands;
    }
}

int main(int argc, char** argv)
{
    if (argc < 2)
    {
        std::cerr << "usage: calculator-oracle <cases.tsv>\n";
        return 2;
    }
    std::ifstream input(argv[1]);
    if (!input)
    {
        std::cerr << "cannot open " << argv[1] << "\n";
        return 2;
    }
    std::string line;
    while (std::getline(input, line))
    {
        if (line.empty() || line[0] == '#')
        {
            continue;
        }
        std::stringstream fields(line);
        std::string id;
        std::string mode;
        std::string commandText;
        std::getline(fields, id, '\t');
        std::getline(fields, mode, '\t');
        std::getline(fields, commandText, '\t');
        Display display;
        Resources resources;
        CalculatorManager manager(&display, &resources);
        if (mode == "scientific")
        {
            manager.SetScientificMode();
        }
        else if (mode == "programmer")
        {
            manager.SetProgrammerMode();
        }
        else
        {
            manager.SetStandardMode();
        }
        for (int command : parseCommands(commandText))
        {
            manager.SendCommand(static_cast<Command>(command));
        }
        std::cout << id << '\t'
                  << W(display.primary) << '\t'
                  << (display.error ? '1' : '0') << '\t'
                  << W(display.expression) << '\t'
                  << W(display.tokenDump) << '\t'
                  << display.maxDigits << '\t'
                  << display.binaryOperators << '\t';
        if (mode == "programmer")
        {
            std::cout << 0;
        }
        else
        {
            const auto history = manager.GetHistoryItems();
            std::cout << history.size();
            for (const auto& item : history)
            {
                std::cout << '\t' << W(item->historyItemVector.expression)
                          << '\t' << W(item->historyItemVector.result);
            }
        }
        std::cout << '\t';
        for (size_t index = 0; index < display.memory.size(); index++)
        {
            if (index > 0)
            {
                std::cout << '|';
            }
            std::cout << W(display.memory[index]);
        }
        std::cout << '\n';
    }
    return 0;
}
